@echo off
title YagzShoes Enterprise POS - Sunucuyu Durdur
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0durdur.ps1"
ping 127.0.0.1 -n 3 >nul
