# install.ps1 - put downloaded project files where they belong.
#
# Save this once in C:\kalshi\kalshi-terminal, then after downloading any files
# from the chat just run:
#
#     .\install.ps1
#
# It looks in Downloads, works out where each file goes from its name, moves it
# there and tells you what it did. Chrome's "(1)" suffixes are handled, so
# "server (2).js" is recognised as server.js.

param(
  [string]$From = "$env:USERPROFILE\Downloads",
  [string]$Root = $PSScriptRoot,
  [switch]$Restart,          # stop the running server and start it again after
  [switch]$WhatIf            # show what would move, move nothing
)

if (-not $Root) { $Root = Get-Location }

# Where each file belongs. Anything not listed here is left alone, so an
# unrelated download never lands in the project by accident.
$routes = @{
  "server.js"         = "."
  "config.json"       = "."
  "package.json"      = "."
  "board.js"          = "lib"
  "crypto.js"         = "lib"
  "execution.js"      = "lib"
  "model.js"          = "lib"
  "risk.js"           = "lib"
  "shadow.js"         = "lib"
  "index.html"        = "public"
}

# Test files all live at the root.
Get-ChildItem $From -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^test[-.].*\.(js|mjs)$' } |
  ForEach-Object { $routes[$_.Name] = "." }

$moved = @()
$skipped = @()

foreach ($file in Get-ChildItem $From -File -ErrorAction SilentlyContinue) {
  # Strip Chrome's duplicate suffix: "server (1).js" -> "server.js"
  $clean = [regex]::Replace($file.Name, '\s*\(\d+\)(?=\.[^.]+$)', '')

  if (-not $routes.ContainsKey($clean)) { continue }

  $destDir = Join-Path $Root $routes[$clean]
  if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  }
  $dest = Join-Path $destDir $clean

  # A file older than the one already installed is almost always a stale
  # download sitting in the folder from an earlier session. Skip it and say so
  # rather than quietly going backwards.
  if (Test-Path $dest) {
    $existing = Get-Item $dest
    if ($file.LastWriteTime -lt $existing.LastWriteTime) {
      $skipped += "  skip  $clean  (the copy in $($routes[$clean]) is newer)"
      continue
    }
  }

  if ($WhatIf) {
    $moved += "  would move  $($file.Name)  ->  $($routes[$clean])\$clean"
  } else {
    Move-Item $file.FullName $dest -Force
    $moved += "  moved  $($file.Name)  ->  $($routes[$clean])\$clean"
  }
}

Write-Host ""
if ($moved.Count -eq 0 -and $skipped.Count -eq 0) {
  Write-Host "  Nothing to install. No project files found in $From" -ForegroundColor DarkGray
  Write-Host ""
  return
}

$moved   | ForEach-Object { Write-Host $_ -ForegroundColor Green }
$skipped | ForEach-Object { Write-Host $_ -ForegroundColor DarkYellow }
Write-Host ""

# A missing lib file crashes the server on startup with a module-not-found
# error that looks unrelated, so check before that happens.
$needed = @("lib\board.js","lib\crypto.js","lib\execution.js","lib\model.js","lib\risk.js","lib\shadow.js","public\index.html","server.js","config.json")
$missing = $needed | Where-Object { -not (Test-Path (Join-Path $Root $_)) }
if ($missing) {
  Write-Host "  MISSING, the server will not start:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  Write-Host ""
  return
}

if ($Restart -and -not $WhatIf) {
  Write-Host "  Restarting..." -ForegroundColor Cyan
  Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 400
  Push-Location $Root
  npm run live
  Pop-Location
} else {
  Write-Host "  All files present. Restart with:  npm run live" -ForegroundColor DarkGray
  Write-Host ""
}
