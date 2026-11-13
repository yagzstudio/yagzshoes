@echo off
title YagzShoes Enterprise POS v2.7
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0baslat.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [UYARI] Sunucu durdu veya beklenmedik bir hata olustu.
    pause
)
