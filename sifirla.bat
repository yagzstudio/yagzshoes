@echo off
title YagzShoes Enterprise POS - Magaza Verilerini Sifirla

cd /d "%~dp0"

echo =========================================================
echo    YAGZSHOES POS - MAGAZA VERILERINI TEMIZLEME
echo =========================================================
echo.
echo DIKKAT: Bu islem tum test satislari, ciroyu, stoklari
echo ve hareketleri sifirlayacaktir.
echo.
pause

node scripts/clean_store_data.js

echo.
echo [TAMAMLANDI] Magaza basariyla sifirlandi.
echo.
pause
