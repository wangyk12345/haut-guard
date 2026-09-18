<#
.SYNOPSIS
  一键构建 HAUT Guard 的 Windows 安装包。

.DESCRIPTION
  依次完成: 校验 Electron 二进制 -> 生成图标 -> 跑测试 -> electron-builder 打包 -> 校验产物。
  每一步失败即中止, 不会产出半成品安装包。

.EXAMPLE
  pwsh -File tools\build.ps1
  pwsh -File tools\build.ps1 -SkipTests
#>
[CmdletBinding()]
param(
  [switch]$SkipTests,
  [switch]$SkipIcon
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$electronMirror = 'https://npmmirror.com/mirrors/electron/'
$builderMirror = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

# electron-builder 收集依赖时会 spawn "powershell.exe", 而本机 PATH 里**没有**
# WindowsPowerShell 目录(文件存在, 但不是 PATH 条目), 于是报 spawn powershell.exe ENOENT。
# 这里显式补上, 否则打包会在最后一步失败。
$psDir = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0'
if ((Test-Path (Join-Path $psDir 'powershell.exe')) -and (($env:PATH -split ';') -notcontains $psDir)) {
  $env:PATH = "$psDir;$env:PATH"
  Write-Host "已把 $psDir 加入 PATH (electron-builder 需要 powershell.exe)" -ForegroundColor DarkGray
}

function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Fail($text) { Write-Host "  [失败] $text" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. 前置检查
Step '1/5 检查构建环境'

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Fail "缺少 node_modules，请先执行: npm install"
}
Ok 'node_modules 存在'

if (-not (Test-Path $electronExe)) {
  Write-Host '  Electron 二进制缺失，尝试重新下载…' -ForegroundColor Yellow
  $env:ELECTRON_MIRROR = $electronMirror
  Push-Location (Join-Path $root 'node_modules\electron')
  try {
    & node install.js
    if ($LASTEXITCODE -ne 0) { Fail "Electron 二进制下载失败 (退出码 $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}
if (-not (Test-Path $electronExe)) { Fail 'Electron 二进制仍不可用' }
Ok "Electron 二进制就绪 ($([math]::Round((Get-Item $electronExe).Length / 1MB, 1)) MB)"

# ---------------------------------------------------------------- 2. 图标
if (-not $SkipIcon) {
  Step '2/5 生成图标'
  # electron.exe 是 GUI 子系统程序, PowerShell 不会等待它, 必须用 Start-Process -Wait
  $proc = Start-Process -FilePath $electronExe -ArgumentList 'tools\make-icon.js' `
    -WorkingDirectory $root -Wait -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $env:TEMP 'haut-icon-out.txt') `
    -RedirectStandardError (Join-Path $env:TEMP 'haut-icon-err.txt')
  if ($proc.ExitCode -ne 0) {
    Get-Content (Join-Path $env:TEMP 'haut-icon-err.txt') -Tail 20 | Write-Host
    Fail "图标生成失败 (退出码 $($proc.ExitCode))"
  }
  foreach ($f in 'build\icon.ico', 'build\icon.png', 'src\assets\icon.png', 'src\assets\tray.png') {
    if (-not (Test-Path (Join-Path $root $f))) { Fail "图标产物缺失: $f" }
  }
  Ok '图标已生成 (build/icon.ico、src/assets/icon.png、src/assets/tray.png)'
} else {
  Step '2/5 跳过图标生成'
}

# ---------------------------------------------------------------- 3. 测试
if (-not $SkipTests) {
  Step '3/5 运行测试'
  & node test\all.js
  if ($LASTEXITCODE -ne 0) { Fail "测试未通过 (退出码 $LASTEXITCODE)，已中止打包" }
  Ok '全部测试通过'
} else {
  Step '3/5 跳过测试'
}

# ---------------------------------------------------------------- 4. 打包
Step '4/5 electron-builder 打包'
$env:ELECTRON_MIRROR = $electronMirror
$env:ELECTRON_BUILDER_BINARIES_MIRROR = $builderMirror
& npx electron-builder --win --config electron-builder.yml
if ($LASTEXITCODE -ne 0) { Fail "打包失败 (退出码 $LASTEXITCODE)" }

# ---------------------------------------------------------------- 5. 校验
Step '5/5 校验产物'
$distDir = Join-Path $root 'dist'
$installer = Get-ChildItem $distDir -Filter '*-Setup-*.exe' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { Fail "dist 目录下没有找到安装包" }

$sizeMb = [math]::Round($installer.Length / 1MB, 1)
$hash = (Get-FileHash $installer.FullName -Algorithm SHA256).Hash
Ok "安装包: $($installer.FullName)"
Write-Host "       大小: $sizeMb MB"
Write-Host "       SHA256: $hash"

$unpacked = Join-Path $distDir 'win-unpacked\HAUT Guard.exe'
if (Test-Path $unpacked) {
  Ok "免安装版: $unpacked"
} else {
  Write-Host '  注意: 未找到 win-unpacked 目录下的主程序' -ForegroundColor Yellow
}

Write-Host "`n构建完成。" -ForegroundColor Green
