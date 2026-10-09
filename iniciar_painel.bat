@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Ambiente Python nao encontrado. Abra o projeto no VS Code e instale as dependencias.
  pause
  exit /b 1
)
start "Risco Zero Subterraneo" ".venv\Scripts\python.exe" app.py
