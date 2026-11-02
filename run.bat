@echo off
chcp 65001 > nul
title Qamqor Health Monitor
cd /d "%~dp0"
echo Запуск Qamqor Health Monitor...
npm start
pause
