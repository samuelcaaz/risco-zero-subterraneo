// Risco Zero Subterraneo - Arduino Uno
// Logica pedida:
// 01100 -> liga bomba/rele
// 00000 -> continua ligada se veio depois de 01100
// 10000 -> desliga bomba/rele

const int boiaInferiorPin = 2; // Sensor inferior/0%
const int boiaSuperiorPin = 3; // Sensor superior/80%
const int releBombaPin = 8;    // IN do rele

// Seu modulo de rele esta ativo em LOW.
const bool releAtivoEmLow = true;

bool drenagemAtiva = false;
bool manualWebAtivo = false;
bool bombaLigada = false;

bool sensorAcionado(int pino) {
  return digitalRead(pino) == LOW;
}

void aplicarBomba(bool ligar) {
  bombaLigada = ligar;

  if (releAtivoEmLow) {
    digitalWrite(releBombaPin, ligar ? LOW : HIGH);
  } else {
    digitalWrite(releBombaPin, ligar ? HIGH : LOW);
  }
}

void setup() {
  pinMode(boiaInferiorPin, INPUT_PULLUP);
  pinMode(boiaSuperiorPin, INPUT_PULLUP);
  pinMode(releBombaPin, OUTPUT);

  aplicarBomba(false);
  Serial.begin(9600);
}

void loop() {
  bool sensorBaixo0 = sensorAcionado(boiaInferiorPin);
  bool sensorCima80 = sensorAcionado(boiaSuperiorPin);

  if (Serial.available() > 0) {
    char comando = Serial.read();

    if (comando == '1') {
      manualWebAtivo = true;
    }

    if (comando == '0') {
      manualWebAtivo = false;
    }
  }

  // 10000: sensor de baixo/0% acionou, entao desliga.
  if (sensorBaixo0) {
    drenagemAtiva = false;
    manualWebAtivo = false;
  }

  // 01100: sensor de cima/80% acionou, entao liga.
  if (!sensorBaixo0 && sensorCima80) {
    drenagemAtiva = true;
  }

  // 00000: se ja estava drenando, continua ligada.
  aplicarBomba(drenagemAtiva || manualWebAtivo);

  // Formato serial: baixo,cima,bomba,manualFisico,manualWeb
  Serial.print(sensorBaixo0 ? 1 : 0);
  Serial.print(',');
  Serial.print(sensorCima80 ? 1 : 0);
  Serial.print(',');
  Serial.print(bombaLigada ? 1 : 0);
  Serial.print(",0,");
  Serial.print(manualWebAtivo ? 1 : 0);
  Serial.println();

  delay(500);
}
