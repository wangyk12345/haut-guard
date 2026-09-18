<#
.SYNOPSIS
  HAUT Guard 真机登录测试(需要能连到校园网网关)。

.DESCRIPTION
  验证的是"应用自己能不能完成认证", 分两段:
    1) 启动应用 -> 应用用 DPAPI 里保存的密码自动登录(账号已在线时会返回"已在线", 同样算成功);
    2) 从**外部**注销当前账号 -> 网络断开 -> 观察应用的"断线自动重连"是否把连接登回来。

  密码不需要出现在本脚本里: 应用自己从 DPAPI 解密; 外部注销只要学号。

  注意: 第 2 步会真的把你的网络断开几秒, 直到应用自动重连成功。

.EXAMPLE
  pwsh -File tools\live-app-test.ps1 -Username <你的学号>
  pwsh -File tools\live-app-test.ps1 -Username <你的学号> -SkipLogout   # 只验证自动登录, 不断网
#>
[CmdletBinding()]
param(
  [string]$Exe = "$env:LOCALAPPDATA\Programs\haut-guard\HAUT Guard.exe",
  # 这里必须传你自己的学号(默认值是占位符, 直接用会注销失败)
  [string]$Username = '20230001',
  [int]$AutoLoginWait = 16,
  [int]$ReconnectWait = 40,
  [switch]$SkipLogout
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$userData = Join-Path $env:APPDATA 'HAUT Guard'
$logPath = Join-Path $userData 'logs\haut-guard.log'
$shot = Join-Path $root 'docs\ui\live-app.png'

function Say($t) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $t) }
function LogTail([int]$n = 12, [string]$pattern = '') {
  if (-not (Test-Path $logPath)) { return @() }
  $lines = Get-Content $logPath -Encoding UTF8
  if ($pattern) { $lines = $lines | Where-Object { $_ -match $pattern } }
  return @($lines | Select-Object -Last $n)
}

if (-not (Test-Path $Exe)) { throw "找不到应用: $Exe" }

Say "启动应用(带 --capture, 用于留下界面证据)"
if (Test-Path $shot) { Remove-Item $shot -Force }
$app = Start-Process -FilePath $Exe -ArgumentList "--capture=$shot", "--capture-delay=9000" -PassThru
Say "应用 pid=$($app.Id), 等待 $AutoLoginWait 秒"
Start-Sleep -Seconds $AutoLoginWait

Write-Host "`n--- 阶段1: 自动登录 ---"
LogTail 12 | ForEach-Object { Write-Host "  $_" }

if (-not (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)) { throw '应用在阶段1退出了' }

if (-not $SkipLogout) {
  Write-Host "`n--- 阶段2: 从外部注销, 观察自动重连 ---"
  if ($Username -eq '20230001') {
    Write-Host "  ! 仍在用占位学号, 阶段2 会失败; 请用 -Username <你的学号> 重跑" -ForegroundColor Yellow
  }
  Say "调用网关注销(会短暂断网)"
  $logoutOut = & node tools\_live-logout.js $Username 2>&1
  $logoutOut | ForEach-Object { Write-Host "  $_" }

  Say "等待 $ReconnectWait 秒, 让应用完成【检测掉线 -> 倒计时 -> 重连】"
  Start-Sleep -Seconds $ReconnectWait

  Write-Host "`n--- 阶段2 日志 ---"
  LogTail 25 '已在线|重连|登录|离线|断开' | ForEach-Object { Write-Host "  $_" }
}

Write-Host "`n--- 最终状态(只读查询) ---"
& node tools\live-status.js 2>&1 | Select-Object -First 12 | ForEach-Object { Write-Host "  $_" }

Say "关闭应用"
if (Get-Process -Id $app.Id -ErrorAction SilentlyContinue) { & taskkill /PID $app.Id /T /F 2>&1 | Out-Null }

if (Test-Path $shot) { Say "界面截图: $shot" }
Say "完成"
