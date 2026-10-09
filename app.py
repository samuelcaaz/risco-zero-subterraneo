import os
import json
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from flask import Flask, jsonify, render_template, request
import serial
from serial.tools import list_ports

app = Flask(__name__)

BAUD_RATE = 9600
SERIAL_PORT = os.getenv("SERIAL_PORT", "COM3")
AUTO_DETECT_PORT = True
REFRESH_INTERVAL_MS = 1000
CONNECTION_GRACE_SECONDS = 10
MAX_SERIAL_FAILURES = 3
HISTORY_LIMIT = 30
LOG_LIMIT = 60

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
SETTINGS_FILE = DATA_DIR / "settings.json"
TELEGRAM_TOKEN_FILE = DATA_DIR / "telegram_token.txt"
DEFAULT_SETTINGS = {
    "responsible_name": "",
    "telegram_chat_id": "",
    "weather_city": "",
    "telegram_alerts_enabled": False,
}
WEATHER_CACHE_SECONDS = 30 * 60

WATER_HEIGHT_CM = 150
SENSOR_MAX = 100

state = {
    "sensor_value": 0,
    "level_percent": 0,
    "status": "NORMAL",
    "pump_on": False,
    "boia_inferior": False,
    "boia_superior": False,
    "manual_fisico": False,
    "manual_web": False,
    "serial_connected": False,
    "serial_port": SERIAL_PORT,
    "last_error": "",
    "last_update": "",
    "last_contact": "",
    "last_serial_line": "",
    "last_serial_at": "",
    "auto_mode": True,
    "monitoring_enabled": True,
    "pump_reason": "Inicializacao do sistema",
}

serial_connection = None
serial_lock = threading.Lock()
state_lock = threading.Lock()
serial_failures = 0
history = deque(maxlen=HISTORY_LIMIT)
event_logs = deque(maxlen=LOG_LIMIT)
settings_lock = threading.Lock()
weather_cache = {}
weather_cache_lock = threading.Lock()


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def now_clock():
    return datetime.now().strftime("%H:%M:%S")


def classify_level(sensor_value):
    if sensor_value < 20:
        return "NORMAL"
    if sensor_value < 80:
        return "ALERTA"
    return "CRITICO"


def sensor_percent(sensor_value):
    return round(max(0, min(100, sensor_value)), 1)


def sensor_cm(sensor_value):
    return round(sensor_percent(sensor_value) * WATER_HEIGHT_CM / 100, 1)


def update_state(**kwargs):
    with state_lock:
        state.update(kwargs)
        state["last_update"] = now_clock()


def add_log(category, message, details=None):
    event_logs.appendleft(
        {
            "timestamp": now_clock(),
            "category": category,
            "message": message,
            "details": details or "",
        }
    )


def add_history(sensor_value, status, pump_on):
    history.append(
        {
            "timestamp": now_clock(),
            "sensor_value": sensor_value,
            "level_percent": sensor_percent(sensor_value),
            "status": status,
            "pump_on": pump_on,
            "manual_fisico": state["manual_fisico"],
            "manual_web": state["manual_web"],
        }
    )


def load_management_settings():
    with settings_lock:
        try:
            stored = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            stored = {}
    return {**DEFAULT_SETTINGS, **stored}


def save_management_settings(settings):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temporary_file = SETTINGS_FILE.with_suffix(".tmp")
    with settings_lock:
        temporary_file.write_text(
            json.dumps(settings, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary_file.replace(SETTINGS_FILE)


def normalized_chat_id(value):
    text = str(value or "").strip()
    sign = "-" if text.startswith("-") else ""
    digits = "".join(character for character in text if character.isdigit())[:20]
    return f"{sign}{digits}" if digits else ""


def telegram_configuration():
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        try:
            token = TELEGRAM_TOKEN_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            token = ""
    return {"configured": bool(token), "token": token}


def save_telegram_token(token):
    clean_token = str(token or "").strip()
    if ":" not in clean_token or len(clean_token) < 20:
        raise ValueError("Token do Telegram invalido.")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    TELEGRAM_TOKEN_FILE.write_text(clean_token, encoding="utf-8")


def telegram_api(method, payload=None):
    configuration = telegram_configuration()
    if not configuration["configured"]:
        raise RuntimeError("Token do bot do Telegram ainda nao configurado.")

    endpoint = f"https://api.telegram.org/bot{configuration['token']}/{method}"
    api_request = Request(
        endpoint,
        data=json.dumps(payload or {}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(api_request, timeout=12) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Telegram recusou a solicitacao: {detail or exc.reason}") from exc
    except (URLError, TimeoutError) as exc:
        raise RuntimeError(f"Falha de rede ao acessar o Telegram: {exc}") from exc

    if not result.get("ok"):
        raise RuntimeError(result.get("description") or "Falha na API do Telegram.")
    return result.get("result")


def send_telegram_message(chat_id, message):
    return telegram_api("sendMessage", {"chat_id": chat_id, "text": message})


def find_latest_telegram_chat():
    updates = telegram_api(
        "getUpdates",
        {"limit": 100, "timeout": 0, "allowed_updates": ["message"]},
    )
    for update in reversed(updates or []):
        message = update.get("message") or {}
        chat = message.get("chat") or {}
        if chat.get("id") is not None:
            name = " ".join(
                part for part in [chat.get("first_name"), chat.get("last_name")] if part
            ) or chat.get("title") or chat.get("username") or "Conversa do Telegram"
            return {"chat_id": str(chat["id"]), "name": name}
    raise RuntimeError("Nenhuma conversa encontrada. Envie /start para o bot e tente novamente.")


def weather_risk(precipitation_mm, probability):
    if precipitation_mm >= 50 or probability >= 80:
        return "ALTO"
    if precipitation_mm >= 20 or probability >= 60:
        return "MODERADO"
    return "BAIXO"


def fetch_json(url):
    api_request = Request(url, headers={"User-Agent": "RiscoZeroSubterraneo/1.0"})
    with urlopen(api_request, timeout=12) as response:
        return json.loads(response.read().decode("utf-8"))


def weather_forecast(city):
    cache_key = city.casefold().strip()
    with weather_cache_lock:
        cached = weather_cache.get(cache_key)
        if cached and time.time() - cached["stored_at"] < WEATHER_CACHE_SECONDS:
            return cached["payload"]

    geocoding_url = "https://geocoding-api.open-meteo.com/v1/search?" + urlencode(
        {"name": city, "count": 1, "language": "pt", "format": "json"}
    )
    location_data = fetch_json(geocoding_url)
    locations = location_data.get("results") or []
    if not locations:
        raise ValueError("Cidade nao encontrada.")

    location = locations[0]
    forecast_url = "https://api.open-meteo.com/v1/forecast?" + urlencode(
        {
            "latitude": location["latitude"],
            "longitude": location["longitude"],
            "daily": "precipitation_sum,precipitation_probability_max,weather_code",
            "timezone": "auto",
            "forecast_days": 5,
        }
    )
    forecast_data = fetch_json(forecast_url)
    daily = forecast_data.get("daily") or {}
    dates = daily.get("time") or []
    precipitation = daily.get("precipitation_sum") or []
    probabilities = daily.get("precipitation_probability_max") or []
    codes = daily.get("weather_code") or []
    days = []
    for index, date in enumerate(dates):
        amount = float(precipitation[index] or 0) if index < len(precipitation) else 0
        probability = int(probabilities[index] or 0) if index < len(probabilities) else 0
        days.append(
            {
                "date": date,
                "precipitation_mm": round(amount, 1),
                "probability": probability,
                "weather_code": codes[index] if index < len(codes) else None,
                "risk": weather_risk(amount, probability),
            }
        )

    payload = {
        "location": ", ".join(
            part for part in [location.get("name"), location.get("admin1")] if part
        ),
        "updated_at": now_clock(),
        "days": days,
    }
    with weather_cache_lock:
        weather_cache[cache_key] = {"stored_at": time.time(), "payload": payload}
    return payload


def mark_connected(port=None):
    global serial_failures

    serial_failures = 0
    update_state(
        serial_connected=True,
        serial_port=port or state["serial_port"],
        last_error="",
        last_contact=now_iso(),
    )


def mark_serial_issue(message, force_disconnect=False):
    global serial_failures

    serial_failures += 1

    recent_contact = False
    last_contact_value = state["last_contact"]
    if last_contact_value:
        try:
            last_contact = datetime.fromisoformat(last_contact_value)
            recent_contact = (
                datetime.now() - last_contact
            ).total_seconds() <= CONNECTION_GRACE_SECONDS
        except ValueError:
            recent_contact = False

    disconnected = force_disconnect or (
        serial_failures >= MAX_SERIAL_FAILURES and not recent_contact
    )

    update_state(
        serial_connected=not disconnected,
        last_error=message,
    )
    add_log(
        "serial",
        "Falha de comunicacao serial",
        message,
    )


def detected_ports():
    return [port.device for port in list_ports.comports()]


def choose_port():
    ports = list(list_ports.comports())
    devices = [port.device for port in ports]

    if SERIAL_PORT in devices:
        return SERIAL_PORT

    if not AUTO_DETECT_PORT:
        return SERIAL_PORT

    for port in ports:
        text = " ".join(
            filter(None, [port.device, port.description, port.manufacturer])
        ).lower()
        if "arduino" in text or "usb serial" in text or "ch340" in text:
            return port.device

    if devices:
        return devices[0]

    return SERIAL_PORT


def open_serial():
    global serial_connection

    with serial_lock:
        if serial_connection is not None and serial_connection.is_open:
            return serial_connection

        port = choose_port()

        try:
            serial_connection = serial.Serial(port, BAUD_RATE, timeout=1, write_timeout=1)
            mark_connected(port)
            add_log("serial", "Conexao serial estabelecida", f"Porta {port}")
            time.sleep(2)
            return serial_connection
        except serial.SerialException as exc:
            serial_connection = None
            update_state(serial_port=port)
            mark_serial_issue(f"Falha na serial: {exc}", force_disconnect=True)
            return None


def close_serial():
    global serial_connection

    with serial_lock:
        if serial_connection is not None:
            try:
                serial_connection.close()
            except serial.SerialException:
                pass
        serial_connection = None


def parse_serial_line(raw_line):
    line = raw_line.strip()
    if not line:
        return

    parts = [part.strip() for part in line.split(",")]
    if len(parts) != 5 or any(part not in {"0", "1"} for part in parts):
        return

    received_at = now_clock()
    print(f"[{received_at}] SERIAL RX: {line}", flush=True)

    boia_inferior, boia_superior, pump_on, manual_fisico, manual_web = [
        part == "1" for part in parts
    ]

    if boia_superior:
        sensor_value = 80
    elif boia_inferior:
        sensor_value = 0
    else:
        sensor_value = 20

    previous_level = state["sensor_value"]
    previous_status = state["status"]
    previous_pump = state["pump_on"]
    status = classify_level(sensor_value)

    if manual_fisico:
        reason = "Interruptor fisico no painel acionou a bomba"
    elif manual_web:
        reason = "Comando manual enviado pelo dashboard"
    elif status == "CRITICO" and pump_on:
        reason = "Controle local no Arduino acionou a bomba por nivel critico"
    elif pump_on:
        reason = "Bomba ligada ate a boia inferior indicar nivel abaixo de 20%"
    else:
        reason = "Boia inferior indicou nivel abaixo de 20%"

    update_state(
        sensor_value=sensor_value,
        level_percent=sensor_percent(sensor_value),
        status=status,
        pump_on=pump_on,
        boia_inferior=boia_inferior,
        boia_superior=boia_superior,
        manual_fisico=manual_fisico,
        manual_web=manual_web,
        last_serial_line=line,
        last_serial_at=received_at,
        auto_mode=not (manual_fisico or manual_web),
        pump_reason=reason,
    )
    mark_connected(state["serial_port"])
    add_history(sensor_value, status, pump_on)

    if status != previous_status:
        add_log(
            "status",
            f"Nivel alterado para {status}",
            f"Boia inferior/parada={int(boia_inferior)}, boia superior/80={int(boia_superior)}",
        )

    if sensor_value != previous_level:
        add_log("nivel", f"Nivel estimado: {sensor_value}%", line)

    if pump_on != previous_pump:
        add_log(
            "bomba",
            "Bomba ligada" if pump_on else "Bomba desligada",
            reason,
        )


def serial_reader():
    while True:
        if not state["monitoring_enabled"]:
            time.sleep(1)
            continue

        connection = open_serial()

        if connection is None:
            time.sleep(2)
            continue

        try:
            raw_line = connection.readline().decode("utf-8", errors="ignore")
            parse_serial_line(raw_line)
        except serial.SerialException as exc:
            mark_serial_issue(f"Leitura serial interrompida: {exc}")
            close_serial()
            time.sleep(2)


def send_command(command):
    connection = open_serial()

    if connection is None:
        raise RuntimeError("Nao foi possivel conectar ao Arduino.")

    try:
        with serial_lock:
            connection.write(command.encode("utf-8"))
            connection.flush()
        mark_connected(state["serial_port"])
    except serial.SerialException as exc:
        mark_serial_issue(f"Falha ao enviar comando: {exc}", force_disconnect=True)
        close_serial()
        raise RuntimeError("Falha ao enviar comando para o Arduino.") from exc


@app.route("/")
def dashboard():
    return render_template(
        "index.html",
        refresh_interval_ms=REFRESH_INTERVAL_MS,
        serial_port=SERIAL_PORT,
    )


@app.route("/ligar", methods=["POST"])
def ligar():
    try:
        send_command("1")
        update_state(
            pump_on=True,
            last_error="",
            pump_reason="Comando manual enviado pelo dashboard",
        )
        add_log("comando", "Comando manual: ligar bomba", "Dashboard -> Arduino")
        return jsonify({"ok": True, "message": "Comando de ligar enviado."})
    except RuntimeError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 500


@app.route("/desligar", methods=["POST"])
def desligar():
    try:
        send_command("0")
        update_state(
            pump_on=False,
            last_error="",
            pump_reason="Comando manual enviado pelo dashboard",
        )
        add_log("comando", "Comando manual: desligar bomba", "Dashboard -> Arduino")
        return jsonify({"ok": True, "message": "Comando de desligar enviado."})
    except RuntimeError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 500


@app.route("/conectar", methods=["POST"])
def conectar():
    update_state(monitoring_enabled=True)
    connection = open_serial()

    if connection is None:
        return jsonify({"ok": False, "message": state["last_error"]}), 500

    add_log("serial", "Monitoramento serial ativado", f"Porta {state['serial_port']}")
    return jsonify({"ok": True, "message": "Arduino conectado ao monitoramento."})


@app.route("/desconectar", methods=["POST"])
def desconectar():
    update_state(
        monitoring_enabled=False,
        serial_connected=False,
        last_error="Monitoramento serial pausado pelo operador",
    )
    close_serial()
    add_log("serial", "Monitoramento serial pausado", "Acao manual no dashboard")
    return jsonify({"ok": True, "message": "Monitoramento serial pausado."})


@app.route("/limpar_logs", methods=["POST"])
def limpar_logs():
    event_logs.clear()
    add_log("sistema", "Logs limpos pelo operador")
    return jsonify({"ok": True, "message": "Logs limpos."})


@app.route("/gerenciamento/configuracoes", methods=["GET", "POST"])
def management_settings():
    if request.method == "GET":
        settings = load_management_settings()
        return jsonify(
            {
                "ok": True,
                "settings": settings,
                "telegram_bot_configured": telegram_configuration()["configured"],
            }
        )

    payload = request.get_json(silent=True) or {}
    settings = {
        "responsible_name": str(payload.get("responsible_name", "")).strip()[:80],
        "telegram_chat_id": normalized_chat_id(payload.get("telegram_chat_id")),
        "weather_city": str(payload.get("weather_city", "")).strip()[:100],
        "telegram_alerts_enabled": bool(payload.get("telegram_alerts_enabled")),
    }
    if settings["telegram_alerts_enabled"] and not settings["telegram_chat_id"]:
        return jsonify(
            {"ok": False, "message": "Informe ou localize o Chat ID para ativar os alertas."}
        ), 400

    bot_token = str(payload.get("telegram_bot_token", "")).strip()
    if bot_token:
        if request.remote_addr not in {"127.0.0.1", "::1"}:
            return jsonify(
                {"ok": False, "message": "Por seguranca, configure o token usando o site aberto neste notebook."}
            ), 403
        try:
            save_telegram_token(bot_token)
        except ValueError as exc:
            return jsonify({"ok": False, "message": str(exc)}), 400

    save_management_settings(settings)
    add_log("sistema", "Configuracoes de gerenciamento atualizadas")
    return jsonify(
        {
            "ok": True,
            "message": "Configuracoes salvas.",
            "settings": settings,
            "telegram_bot_configured": telegram_configuration()["configured"],
        }
    )


@app.route("/gerenciamento/localizar_telegram", methods=["POST"])
def locate_telegram():
    try:
        chat = find_latest_telegram_chat()
        return jsonify({"ok": True, "message": "Conversa localizada.", "chat": chat})
    except RuntimeError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 503


@app.route("/gerenciamento/testar_telegram", methods=["POST"])
def test_telegram():
    settings = load_management_settings()
    chat_id = normalized_chat_id(settings.get("telegram_chat_id"))
    if not chat_id:
        return jsonify({"ok": False, "message": "Cadastre primeiro o Chat ID do Telegram."}), 400
    try:
        send_telegram_message(
            chat_id,
            "RISCO ZERO SUBTERRANEO\n\nTeste concluido: o canal de alertas esta funcionando.",
        )
        add_log("alerta", "Mensagem de teste enviada pelo Telegram", chat_id)
        return jsonify({"ok": True, "message": "Mensagem de teste enviada pelo Telegram."})
    except RuntimeError as exc:
        add_log("alerta", "Falha no teste do Telegram", str(exc))
        return jsonify({"ok": False, "message": str(exc)}), 503


@app.route("/gerenciamento/previsao")
def management_forecast():
    city = str(request.args.get("cidade", "")).strip()
    if len(city) < 2:
        return jsonify({"ok": False, "message": "Informe uma cidade para consultar a previsao."}), 400
    try:
        forecast = weather_forecast(city)
        return jsonify({"ok": True, "forecast": forecast})
    except ValueError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 404
    except (HTTPError, URLError, TimeoutError, KeyError, TypeError, json.JSONDecodeError) as exc:
        return jsonify({"ok": False, "message": f"Nao foi possivel consultar a previsao: {exc}"}), 503


@app.route("/relatorio")
def operational_report():
    with state_lock:
        state_snapshot = dict(state)
    return render_template(
        "report.html",
        generated_at=datetime.now().strftime("%d/%m/%Y %H:%M:%S"),
        state=state_snapshot,
        settings=load_management_settings(),
        logs=list(event_logs),
        history=list(history),
    )


@app.route("/dados")
def dados():
    payload = dict(state)
    payload["sensor_percent"] = sensor_percent(state["sensor_value"])
    payload["sensor_cm"] = sensor_cm(state["sensor_value"])
    payload["sensor_max"] = SENSOR_MAX
    payload["water_height_cm"] = WATER_HEIGHT_CM
    if state["last_contact"]:
        try:
            last_contact = datetime.fromisoformat(state["last_contact"])
            payload["serial_connected"] = (
                datetime.now() - last_contact
            ).total_seconds() <= CONNECTION_GRACE_SECONDS
        except ValueError:
            payload["serial_connected"] = state["serial_connected"]
    payload["available_ports"] = detected_ports()
    payload["refresh_interval_ms"] = REFRESH_INTERVAL_MS
    payload["history"] = list(history)
    payload["logs"] = list(event_logs)
    return jsonify(payload)


reader_thread = threading.Thread(target=serial_reader, daemon=True)
reader_thread.start()


def critical_alert_monitor():
    drainage_cycle_notified = False
    while True:
        with state_lock:
            critical_with_pump = state["status"] == "CRITICO" and state["pump_on"]
            drainage_finished = state["sensor_value"] <= 0 and not state["pump_on"]

        if critical_with_pump and not drainage_cycle_notified:
            drainage_cycle_notified = True
            settings = load_management_settings()
            chat_id = normalized_chat_id(settings.get("telegram_chat_id"))
            if settings.get("telegram_alerts_enabled") and chat_id:
                try:
                    send_telegram_message(
                        chat_id,
                        "RISCO ZERO SUBTERRANEO\n\nALERTA CRITICO: nivel maximo atingido. A bomba foi ativada automaticamente.",
                    )
                    add_log(
                        "alerta",
                        "Alerta critico enviado ao responsavel",
                        "Telegram: nivel critico atingido e bomba ativada",
                    )
                except RuntimeError as exc:
                    add_log("alerta", "Falha ao enviar alerta critico", str(exc))
        elif drainage_finished and drainage_cycle_notified:
            settings = load_management_settings()
            chat_id = normalized_chat_id(settings.get("telegram_chat_id"))
            if settings.get("telegram_alerts_enabled") and chat_id:
                try:
                    send_telegram_message(
                        chat_id,
                        "RISCO ZERO SUBTERRANEO\n\nDrenagem concluida: nivel minimo atingido e bomba desligada.",
                    )
                    add_log(
                        "alerta",
                        "Aviso de drenagem concluida enviado",
                        "Telegram: nivel minimo e bomba desligada",
                    )
                except RuntimeError as exc:
                    add_log("alerta", "Falha ao enviar conclusao da drenagem", str(exc))
            drainage_cycle_notified = False

        time.sleep(1)


alert_thread = threading.Thread(target=critical_alert_monitor, daemon=True)
alert_thread.start()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True, use_reloader=False)
