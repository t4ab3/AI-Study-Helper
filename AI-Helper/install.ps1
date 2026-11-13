# AI Helper: setup from scratch. Started by install.bat.
# Everything that has to be downloaded goes to the "tools" folder next to this file; nothing is
# installed system-wide, nothing needs administrator rights. Run it again at any time: finished
# steps are skipped.
param(
  # for testing: ignore Python / Node.js already installed on this computer
  [switch]$ForcePortable,
  # do not offer to start the bridge at the end
  [switch]$NoStart,
  # for testing: no desktop shortcut, no clipboard, Chrome is not opened
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = $PSScriptRoot
$Tools = Join-Path $Root 'tools'
$Bridge = Join-Path $Root 'bridge'
$Ext = Join-Path $Root 'extension'
$PythonVersion = '3.12.10'

function Step($n, $text) { Write-Host ''; Write-Host "[$n/6] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Info($text) { Write-Host "      $text" }
function Fail($text) {
  Write-Host ''
  Write-Host "ОШИБКА: $text" -ForegroundColor Red
  Write-Host 'Исправьте причину и запустите install.bat ещё раз: готовые шаги повторяться не будут.'
  exit 1
}

function Download($url, $file) {
  Info "Скачиваю $url"
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path $curl) {
    & $curl -L --fail --silent --show-error --retry 3 -o $file $url
    if ($LASTEXITCODE -eq 0) { return }
  }
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
}

function Unzip($zip, $dest) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) {
    & $tar -xf $zip -C $dest
    if ($LASTEXITCODE -eq 0) { return }
  }
  Expand-Archive -Path $zip -DestinationPath $dest -Force
}

# ---------------------------------------------------------------- Python
function Test-Python($exe) {
  # a real Python 3.10-3.13 with venv (the Microsoft Store stub and too new versions do not count:
  # the speech recognition library has no builds for them yet)
  if (-not $exe -or $exe -like '*\WindowsApps\*') { return $null }
  try {
    $out = & $exe -c "import sys, venv; v = sys.version_info; print(sys.executable if (3, 10) <= v[:2] <= (3, 13) else '')" 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) { return ($out | Select-Object -Last 1).Trim() }
  } catch { }
  return $null
}

function Find-Python {
  $own = Join-Path $Tools 'python\python.exe'
  if (Test-Path $own) { $p = Test-Python $own; if ($p) { return $p } }
  if ($ForcePortable) { return $null }
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    foreach ($v in '3.12', '3.13', '3.11', '3.10') {
      try {
        $exe = & $py.Source "-$v" -c 'import sys; print(sys.executable)' 2>$null
        if ($LASTEXITCODE -eq 0 -and $exe) { $p = Test-Python ($exe | Select-Object -Last 1).Trim(); if ($p) { return $p } }
      } catch { }
    }
  }
  foreach ($c in (Get-Command python -All -ErrorAction SilentlyContinue)) {
    $p = Test-Python $c.Source
    if ($p) { return $p }
  }
  return $null
}

function Install-Python {
  # the official Python build packaged for NuGet: a plain zip with pip and venv, no installer,
  # no registry entries; python.exe inside is signed by the Python Software Foundation
  $zip = Join-Path $Tools "python-$PythonVersion.zip"
  $tmp = Join-Path $Tools 'python-unpack'
  New-Item -ItemType Directory -Force -Path $Tools | Out-Null
  Download "https://www.nuget.org/api/v2/package/python/$PythonVersion" $zip
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Unzip $zip $tmp
  $exe = Join-Path $tmp 'tools\python.exe'
  if (-not (Test-Path $exe)) { Fail 'В скачанном архиве Python нет python.exe.' }
  $sig = Get-AuthenticodeSignature $exe
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Python Software Foundation') {
    Fail "Подпись скачанного python.exe не прошла проверку ($($sig.Status)). Файл не используется."
  }
  $dest = Join-Path $Tools 'python'
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item (Join-Path $tmp 'tools') $dest
  Remove-Item -Recurse -Force $tmp
  Remove-Item -Force $zip
  $p = Test-Python (Join-Path $dest 'python.exe')
  if (-not $p) { Fail 'Скачанный Python не запускается.' }
  return $p
}

# ---------------------------------------------------------------- Node.js
function Test-Node($exe) {
  if (-not $exe) { return $false }
  try {
    $v = & $exe --version 2>$null
    return ($LASTEXITCODE -eq 0 -and "$v" -match '^v(\d+)\.' -and [int]$Matches[1] -ge 18)
  } catch { return $false }
}

function Find-Node {
  $own = Get-ChildItem -Path $Tools -Directory -Filter 'node-v*-win-x64' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($own -and (Test-Node (Join-Path $own.FullName 'node.exe'))) { return $own.FullName }
  if ($ForcePortable) { return $null }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node -and (Test-Node $node.Source)) {
    $dir = Split-Path $node.Source
    if (Test-Path (Join-Path $dir 'npm.cmd')) { return $dir }
  }
  return $null
}

function Install-Node {
  # the current LTS release from nodejs.org as a zip, checked against the published SHA-256
  New-Item -ItemType Directory -Force -Path $Tools | Out-Null
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $rel = $index | Where-Object { $_.lts -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
  if (-not $rel) { Fail 'Не удалось узнать актуальную версию Node.js на nodejs.org.' }
  $name = "node-$($rel.version)-win-x64"
  $zip = Join-Path $Tools "$name.zip"
  Download "https://nodejs.org/dist/$($rel.version)/$name.zip" $zip
  $sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$($rel.version)/SHASUMS256.txt" -UseBasicParsing).Content
  $want = ($sums -split "`n" | Where-Object { $_ -match " $([regex]::Escape("$name.zip"))\s*$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
  $got = (Get-FileHash -Algorithm SHA256 $zip).Hash
  if (-not $want -or $got -ne $want.ToUpper()) { Remove-Item -Force $zip; Fail 'Контрольная сумма Node.js не совпала. Файл удалён.' }
  Unzip $zip $Tools
  Remove-Item -Force $zip
  $dir = Join-Path $Tools $name
  if (-not (Test-Node (Join-Path $dir 'node.exe'))) { Fail 'Скачанный Node.js не запускается.' }
  return $dir
}

# ---------------------------------------------------------------- Chrome
function Find-Chrome {
  $paths = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return $p } }
  foreach ($k in 'HKCU:', 'HKLM:') {
    try {
      $v = (Get-ItemProperty "$k\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" -ErrorAction Stop).'(default)'
      if ($v -and (Test-Path $v)) { return $v }
    } catch { }
  }
  return $null
}

Write-Host 'AI Helper: установка' -ForegroundColor White
Info "Папка программы: $Root"

# 1. Python
Step 1 'Python'
$python = Find-Python
if ($python) { Ok "найден: $python" }
else {
  Info "Подходящего Python (3.10–3.13) нет. Скачиваю Python $PythonVersion в папку tools (~20 МБ)."
  $python = Install-Python
  Ok "установлен: $python"
}

# 2. Node.js
Step 2 'Node.js (нужен только для сборки расширения)'
$nodeDir = Find-Node
if ($nodeDir) { Ok "найден: $nodeDir" }
else {
  Info 'Node.js 18+ нет. Скачиваю Node.js LTS в папку tools (~30 МБ).'
  $nodeDir = Install-Node
  Ok "установлен: $nodeDir"
}

# 3. extension
Step 3 'Сборка расширения'
$env:Path = "$nodeDir;$env:Path"
$npm = Join-Path $nodeDir 'npm.cmd'
Push-Location $Ext
try {
  $lockStamp = Join-Path $Ext 'node_modules\.installed-lock'
  $lock = Join-Path $Ext 'package-lock.json'
  $needInstall = -not (Test-Path $lockStamp) -or ((Get-FileHash $lock).Hash -ne (Get-Content $lockStamp -ErrorAction SilentlyContinue))
  if ($needInstall) {
    Info 'Устанавливаю зависимости (npm ci), 1–3 минуты...'
    & $npm ci --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci не удался. Проверьте интернет.' }
    Set-Content -Path $lockStamp -Value (Get-FileHash $lock).Hash -Encoding ascii
  }
  Info 'Собираю...'
  & $npm run build --silent | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'Сборка расширения не удалась (npm run build). Запустите её в папке extension, чтобы увидеть ошибку.' }
} finally { Pop-Location }
$dist = Join-Path $Ext 'dist'
if (-not (Test-Path (Join-Path $dist 'manifest.json'))) { Fail 'После сборки нет extension\dist\manifest.json.' }
Ok "расширение собрано: $dist"

# 4. bridge
Step 4 'Библиотеки bridge (распознавание речи, управление окном DeepSeek, Word)'
$venvPy = Join-Path $Bridge '.venv\Scripts\python.exe'
if ((Test-Path $venvPy) -and -not (Test-Python $venvPy)) {
  Info 'Старое окружение .venv не работает (Python удалили или перенесли папку), создаю заново.'
  Remove-Item -Recurse -Force (Join-Path $Bridge '.venv')
}
if (-not (Test-Path $venvPy)) {
  & $python -m venv (Join-Path $Bridge '.venv')
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPy)) { Fail 'Не удалось создать окружение bridge\.venv.' }
}
$req = Join-Path $Bridge 'requirements.txt'
$stamp = Join-Path $Bridge '.venv\installed-requirements.txt'
$same = (Test-Path $stamp) -and ((Get-FileHash $req).Hash -eq (Get-FileHash $stamp).Hash)
if (-not $same) {
  Info 'Устанавливаю библиотеки. Это самый долгий шаг: 5–15 минут, ~1,5 ГБ с библиотеками видеокарты.'
  & $venvPy -m pip install --disable-pip-version-check -q --upgrade pip
  & $venvPy -m pip install --disable-pip-version-check -q -r $req
  if ($LASTEXITCODE -ne 0) { Fail 'Не удалось установить библиотеки bridge. Проверьте интернет.' }
  if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    Info 'Найдена видеокарта NVIDIA: ставлю библиотеки CUDA для быстрого распознавания речи.'
    & $venvPy -m pip install --disable-pip-version-check -q -r (Join-Path $Bridge 'requirements-gpu.txt')
    if ($LASTEXITCODE -ne 0) { Info 'Библиотеки CUDA не установились: распознавание будет работать на процессоре.' }
  }
  Copy-Item $req $stamp -Force
}
$importOk = $false
try { & $venvPy -c 'import selenium, faster_whisper, docx' 2>$null; $importOk = ($LASTEXITCODE -eq 0) } catch { }
if (-not $importOk) { Fail 'Библиотеки bridge установились не полностью.' }
Ok 'библиотеки установлены'

# 5. Chrome and the desktop shortcut
Step 5 'Google Chrome и ярлык'
$chrome = Find-Chrome
if ($chrome) { Ok "Chrome найден: $chrome" }
else {
  Write-Host '  !!  Google Chrome не найден. Установите его с https://www.google.com/chrome/ и запустите install.bat ещё раз.' -ForegroundColor Yellow
  if (-not $Quiet) { Start-Process 'https://www.google.com/chrome/' }
}
if (-not $Quiet) { try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'AI Helper (bridge).lnk'))
  $lnk.TargetPath = Join-Path $Bridge 'start_bridge.bat'
  $lnk.WorkingDirectory = $Bridge
  $lnk.Description = 'Запуск bridge AI Helper'
  $icon = Join-Path $Bridge 'ai-helper.ico'
  if (Test-Path $icon) { $lnk.IconLocation = $icon }
  $lnk.Save()
  Ok 'на рабочем столе ярлык «AI Helper (bridge)»'
} catch { Info "Ярлык создать не удалось: $($_.Exception.Message)" } }

# 6. loading the extension into Chrome: Chrome only allows this by hand
Step 6 'Подключение расширения к Chrome'
if (-not $Quiet) { try { Set-Clipboard -Value $dist } catch { } }
Write-Host ''
Write-Host '  Осталось сделать один раз вручную (Chrome не разрешает программам делать это самим):' -ForegroundColor Yellow
Write-Host '   1. В Chrome откроется страница chrome://extensions.'
Write-Host '   2. Справа вверху включите «Режим разработчика».'
Write-Host '   3. Нажмите «Загрузить распакованное расширение».'
Write-Host '   4. В адресную строку окна выбора папки вставьте путь (Ctrl+V, он уже скопирован) и нажмите «Выбор папки»:'
Write-Host "      $dist" -ForegroundColor White
Write-Host '   5. Закрепите значок AI Helper на панели Chrome (значок пазла → булавка).'
Write-Host '  Если расширение уже подключено, просто нажмите у него «Обновить».'
if ($chrome -and -not $Quiet) { try { Start-Process $chrome 'chrome://extensions' } catch { } }

Write-Host ''
Write-Host 'Готово.' -ForegroundColor Green
Write-Host 'Дальше запускайте программу ярлыком «AI Helper (bridge)» на рабочем столе (или bridge\start_bridge.bat).'
Write-Host 'Окно bridge держите открытым, пока пользуетесь расширением.'
if (-not $NoStart) {
  $answer = Read-Host 'Запустить bridge сейчас? (Y/N, Enter = да)'
  if ($answer -notmatch '^[nNтТнН]') {
    Start-Process -FilePath (Join-Path $Bridge 'start_bridge.bat') -WorkingDirectory $Bridge
  }
}
exit 0
