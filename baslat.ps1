# YagzShoes Enterprise POS - PowerShell Başlatıcı
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "   👟 YAGZSHOES ENTERPRISE POS - HIZLI BAŞLATICI        " -ForegroundColor Yellow
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host ""

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# 1. Node kontrolü
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[HATA] Node.js sisteminizde kurulu bulunamadı!" -ForegroundColor Red
    Write-Host "Lütfen https://nodejs.org adresinden Node.js kurun." -ForegroundColor Gray
    pause
    exit 1
}

# 2. Port belirleme (.env dosyasından oku veya varsayılan 3000)
$port = 3000
if (Test-Path ".env") {
    $envContent = Get-Content ".env"
    foreach ($line in $envContent) {
        if ($line -match "^PORT\s*=\s*(\d+)") {
            $port = [int]$matches[1]
        }
    }
} elseif (Test-Path ".env.example") {
    Copy-Item ".env.example" ".env"
}

# 3. server.pid kontrolü ve eski işlemleri temizleme
if (Test-Path "server.pid") {
    $oldPid = Get-Content "server.pid" -ErrorAction SilentlyContinue
    if ($oldPid) {
        $oldProc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($oldProc -and $oldProc.ProcessName -match "node") {
            Write-Host "[BİLGİ] server.pid ile belirtilen eski sunucu işlemi sonlandırılıyor (PID: $oldPid)..." -ForegroundColor Yellow
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item "server.pid" -Force -ErrorAction SilentlyContinue
}

# 4. Port üzerinde dinleyen eski Node işlemi varsa temizle
$connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($connections) {
    foreach ($conn in $connections) {
        $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -match "node") {
            Write-Host "[BİLGİ] Port $port üzerinde aktif Node işlemi bulundu (PID: $($conn.OwningProcess)), temizleniyor..." -ForegroundColor Yellow
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
}

# 5. Bağımlılık kontrolü
if (-not (Test-Path "node_modules")) {
    Write-Host "[BİLGİ] Bağımlılıklar yükleniyor, lütfen bekleyin..." -ForegroundColor Gray
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[HATA] Bağımlılık kurulumu başarısız oldu!" -ForegroundColor Red
        pause
        exit 1
    }
}

# 6. Tarayıcıyı arka planda gecikmeli aç
Start-Job -ScriptBlock {
    param($p)
    Start-Sleep -Seconds 2
    Start-Process "http://localhost:$p"
} -ArgumentList $port | Out-Null

Write-Host "[1/2] Sunucu başlatılıyor -> http://localhost:$port" -ForegroundColor Green
Write-Host "[2/2] Tarayıcı 2 saniye içinde otomatik açılacak..." -ForegroundColor Gray
Write-Host "[BİLGİ] Sunucuyu durdurmak için Ctrl+C yapabilir veya durdur.bat çalıştırabilirsiniz.`n" -ForegroundColor DarkGray
Write-Host "=========================================================`n" -ForegroundColor Cyan

# 7. Sunucuyu başlat ve PID kaydet
try {
    $proc = Start-Process -FilePath "node" -ArgumentList "server.js" -PassThru -NoNewWindow
    $proc.Id | Set-Content "server.pid"
    $proc.WaitForExit()
} finally {
    if (Test-Path "server.pid") {
        Remove-Item "server.pid" -Force -ErrorAction SilentlyContinue
    }
}
