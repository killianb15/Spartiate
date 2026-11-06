@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Lancement de Spartiate Arenes sur http://localhost:8123
echo (laisse cette fenetre ouverte pendant que tu joues)
start "" cmd /c "timeout /t 1 >nul & start http://localhost:8123/"
python serveur.py || py serveur.py
pause
