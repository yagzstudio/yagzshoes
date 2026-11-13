# YagzShoes Enterprise POS - PowerShell Durdurucu
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "   🛑 YAGZSHOES POS SUNUCUSU DURDURULUYOR...            " -ForegroundColor Red
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host ""

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Port belirleme (.env dosyasından oku veya varsayılan 3000)
$port = 3000
if (Test-Path ".env") {
    $envContent = Get-Content ".env"
    foreach ($line in $envContent) {
        if ($line -match "^PORT\s*=\s*(\d+)") {
            $port = [int]$matches[1]
        }
    }
}

$stopped = $false

# 1. server.pid üzerinden durdur
if (Test-Path "server.pid") {
    $pidToStop = Get-Content "server.pid" -ErrorAction SilentlyContinue
    if ($pidToStop) {
        $p = Get-Process -Id $pidToStop -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -match "node") {
            Write-Host "[BİLGİ] server.pid ile belirtilen Node işlemi sonlandırılıyor (PID: $pidToStop)..." -ForegroundColor Yellow
            Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue
            $stopped = $true
        }
    }
    Remove-Item "server.pid" -Force -ErrorAction SilentlyContinue
}

# 2. Port üzerindeki Node bağlantısını bul ve sonlandır
$connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($connections) {
    foreach ($conn in $connections) {
        $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -match "node") {
            Write-Host "[BİLGİ] Port $port üzerinde çalışan Node işlemi sonlandırılıyor (PID: $($conn.OwningProcess))." -ForegroundColor Yellow
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            $stopped = $true
        }
    }
}

if ($stopped) {
    Write-Host "`n[BAŞARILI] YagzShoes POS sunucusu başarıyla durduruldu.`n" -ForegroundColor Green
} else {
    Write-Host "[BİLGİ] Port $port üzerinde veya server.pid ile aktif bir YagzShoes sunucusu bulunamadı.`n" -ForegroundColor Gray
}
