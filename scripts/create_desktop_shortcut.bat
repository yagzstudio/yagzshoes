@echo off
chcp 65001 >nul
title YagzShoes POS - Masaüstü Kısayolu Oluşturucu

set "TARGET_DIR=%~dp0.."
pushd "%TARGET_DIR%"
set "APP_DIR=%CD%"
popd

set "SCRIPT=%TEMP%\create_shortcut.vbs"
echo Set oWS = WScript.CreateObject("WScript.Shell") > "%SCRIPT%"
echo sLinkFile = oWS.SpecialFolders("Desktop") ^& "\YagzShoes POS.lnk" >> "%SCRIPT%"
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> "%SCRIPT%"
echo oLink.TargetPath = "%APP_DIR%\baslat.bat" >> "%SCRIPT%"
echo oLink.WorkingDirectory = "%APP_DIR%" >> "%SCRIPT%"
echo oLink.Description = "YagzShoes Enterprise POS Sistemi" >> "%SCRIPT%"
echo oLink.Save >> "%SCRIPT%"

cscript /nologo "%SCRIPT%"
del "%SCRIPT%"

echo.
echo [BAŞARILI] Masaüstünüze "YagzShoes POS" kısayolu eklendi!
echo Artık masaüstündeki simgeye çift tıklayarak sistemi başlatabilirsiniz.
echo.
pause
