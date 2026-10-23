$ErrorActionPreference = 'Stop'
$pythonPath = 'E:\Codex\work\anyi-ai-venv\Scripts\python.exe'
Set-Location $PSScriptRoot
$installTemp = 'E:\Codex\tmp\anyi-ai-install'
New-Item -ItemType Directory -Force $installTemp | Out-Null
$env:TEMP = $installTemp
$env:TMP = $installTemp
if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -m venv E:\Codex\work\anyi-ai-venv
    if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment creation failed' }
}
& $pythonPath -m pip install --cache-dir E:\Codex\tool-cache\pip -r requirements-lock.txt
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
& $pythonPath -B setup_assets.py
if ($LASTEXITCODE -ne 0) { throw 'Local speech model or tokenizer setup failed' }
& $pythonPath -B -m uvicorn main:app --host 127.0.0.1 --port 8000
