@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Spartiate Arenes

rem Cherche Python 3.7+ : le lanceur "py" d'abord, puis "python" (en evitant le faux
rem python du Microsoft Store, qui ouvre le Store au lieu de lancer le script).
set "PY="
py -3 -c "import sys; sys.exit(sys.version_info < (3, 7))" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(sys.version_info < (3, 7))" >nul 2>&1 && set "PY=python"
if not defined PY goto nopython

%PY% serveur.py %*
pause
exit /b

:nopython
echo Python 3.7 ou plus recent est necessaire pour lancer le jeu.
echo.
echo  - Installe-le depuis https://www.python.org/downloads/
echo    (coche bien "Add python.exe to PATH" pendant l'installation)
echo  - ou, dans un terminal : winget install Python.Python.3.12
echo.
echo Puis relance jouer.bat.
pause
