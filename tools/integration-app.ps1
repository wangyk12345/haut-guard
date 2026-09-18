<#
.SYNOPSIS
  端到端联调: 启动模拟网关 + 真实应用, 检查日志与界面, 并截图。

.DESCRIPTION
  验证的是"主进程与渲染层真的接上了": 应用会从模拟网关读到在线态(无需登录),
  脚本随后检查本次运行是否产生 [ERROR] 或渲染层异常, 并对窗口截一张屏。

  默认用 node_modules 里的 electron 跑开发版; 传 -Exe 可以指定打包后的主程序,
  用来验收安装包产物。

.EXAMPLE
  pwsh -File tools\integration-app.ps1
  pwsh -File tools\integration-app.ps1 -Exe "dist\win-unpacked\HAUT Guard.exe"
#>
[CmdletBinding()]
param(
  [string]$Exe = '',
  [int]$Port = 6900,
  [int]$WaitSeconds = 15,
  [string]$Out = 'docs\ui\real-app.png',
  [switch]$SkipScreenshot
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$userData = Join-Path $env:APPDATA 'HAUT Guard'
$configPath = Join-Path $userData 'config.json'
$logPath = Join-Path $userData 'logs\haut-guard.log'
$mockLog = Join-Path $env:TEMP 'haut-integration-mock.log'
$mockErr = Join-Path $env:TEMP 'haut-integration-mock-err.log'

function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  [!!] $text" -ForegroundColor Yellow }

# 记住原配置, 结束时还原, 免得把用户的网关改成 127.0.0.1
$originalConfig = if (Test-Path $configPath) { [System.IO.File]::ReadAllBytes($configPath) } else { $null }

$mock = $null
$app = $null
$failures = @()

try {
  # ---------------------------------------------------------------- 1. 模拟网关
  Step "1/5 启动模拟网关 (端口 $Port)"
  New-Item -ItemType Directory -Path $userData -Force | Out-Null
  $mock = Start-Process -FilePath 'node' -ArgumentList 'tools\_run-mock.js', $Port `
    -WorkingDirectory $root -PassThru -NoNewWindow `
    -RedirectStandardOutput $mockLog -RedirectStandardError $mockErr

  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $client.Connect('127.0.0.1', $Port)
      $client.Close()
      $ready = $true
      break
    } catch { }
  }
  if (-not $ready) { throw "模拟网关未能在 10 秒内监听 $Port 端口" }
  Ok "模拟网关已就绪 (预置 1 个在线会话)"

  # ---------------------------------------------------------------- 2. 配置
  Step '2/5 把应用指向模拟网关 (无 BOM 的 UTF-8)'
  $json = @"
{
  "gateway": "127.0.0.1",
  "portalPort": $Port,
  "statusPort": $Port,
  "autoLogin": false,
  "autoLaunch": false,
  "remember": true,
  "autoReconnect": false,
  "startMinimized": false,
  "pollInterval": 10,
  "theme": "dark",
  "material": "transparent",
  "passwordAlgo": "srun3",
  "infoFormat": "srun3",
  "lastUsername": "20230001"
}
"@
  [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Ok "config.json -> 127.0.0.1:$Port"

  # ---------------------------------------------------------------- 3. 启动应用
  Step '3/5 启动应用'
  $logSizeBefore = if (Test-Path $logPath) { (Get-Item $logPath).Length } else { 0 }

  if (-not $Exe) { $Exe = Join-Path $root 'node_modules\electron\dist\electron.exe' }
  if (-not (Test-Path $Exe)) { throw "找不到可执行文件: $Exe" }
  $isDev = $Exe -like '*\electron.exe'

  # 截图交给应用自带的 --capture(webContents.capturePage): 系统级截图在窗口被
  # 遮挡时会截到别人的内容, 而 capturePage 只取本窗口渲染结果, 稳定可靠。
  # 故意不加 --capture-exit, 让应用继续运行以便后面检查日志与存活状态。
  $shotPath = Join-Path $root $Out
  if (Test-Path $shotPath) { Remove-Item $shotPath -Force }
  $captureArgs = @("--capture=$shotPath", "--capture-delay=$([int]($WaitSeconds * 1000 * 0.6))")

  # 打包后的主程序不带 "."; 开发版要显式给 "." 告诉 electron 用当前目录作为应用。
  # 注意不能给 Start-Process 传空数组的 -ArgumentList(会报参数为 null/空)。
  $appArgs = if ($isDev) { @('.') + $captureArgs } else { $captureArgs }
  $app = Start-Process -FilePath $Exe -ArgumentList $appArgs -WorkingDirectory $root -PassThru
  Write-Host "  pid=$($app.Id)，等待 $WaitSeconds 秒…"
  Start-Sleep -Seconds $WaitSeconds

  if (-not (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)) {
    throw '应用在等待期间退出了(启动崩溃)'
  }
  Ok '应用仍在运行'

  # ---------------------------------------------------------------- 4. 检查日志
  Step '4/5 检查本次运行的日志'
  $newLines = @()
  if (Test-Path $logPath) {
    $all = Get-Content $logPath -Encoding UTF8
    $beforeLines = 0
    if ($logSizeBefore -gt 0) {
      # 粗略按字节比例估算旧行数不可靠, 改为按"本次运行起始标记"截取
      $startIdx = -1
      for ($i = $all.Count - 1; $i -ge 0; $i--) {
        if ($all[$i] -like '*=== HAUT Guard*启动*') { $startIdx = $i; break }
      }
      if ($startIdx -ge 0) { $newLines = $all[$startIdx..($all.Count - 1)] }
      else { $newLines = $all }
    } else {
      $newLines = $all
    }
  }

  # 注意: 必须用 -match 并转义方括号。PowerShell 的 -like 里 [] 是字符类,
  # '*[ERROR]*' 会匹配任何含 E/R/O 的行 —— 会把 INFO 行全部误判成错误。
  $errors = @($newLines | Where-Object { $_ -match '\[ERROR\]' })
  $uiIssues = @($newLines | Where-Object { $_ -match '\[界面\]' })
  $infos = @($newLines | Where-Object { $_ -match '\[INFO \]' })
  $otherWarns = @($newLines | Where-Object { $_ -match '\[WARN \]' -and $_ -notmatch '\[界面\]' })

  Write-Host "  本次运行日志 $($newLines.Count) 行: INFO $($infos.Count), 其它 WARN $($otherWarns.Count), ERROR $($errors.Count), 渲染层异常 $($uiIssues.Count)"
  foreach ($line in $infos) { Write-Host "    $line" }
  foreach ($line in $otherWarns) { Warn $line }

  if ($errors.Count -gt 0) {
    $failures += "日志里有 $($errors.Count) 条 [ERROR]"
    foreach ($line in $errors) { Write-Host "    $line" -ForegroundColor Red }
  }
  if ($uiIssues.Count -gt 0) {
    # 同一类渲染异常会每秒刷屏, 只报去重后的种类数, 避免输出被淹没
    $kinds = @($uiIssues | ForEach-Object { ($_ -split '\] ', 2)[-1] } | Sort-Object -Unique)
    $failures += "渲染层有 $($uiIssues.Count) 条异常(共 $($kinds.Count) 类)"
    foreach ($kind in $kinds) { Write-Host "    $kind" -ForegroundColor Red }
  }

  $online = @($newLines | Where-Object { $_ -like '*已在线*' })
  if ($online.Count -gt 0) { Ok "状态解析成功: $($online[-1].Trim())" }
  else { $failures += '日志里没有出现"已在线"，状态查询可能失败' }

  # ---------------------------------------------------------------- 5. 截图
  if (-not $SkipScreenshot) {
    Step '5/5 界面截图'
    if (Test-Path $shotPath) {
      Ok "截图: $Out ($((Get-Item $shotPath).Length) bytes)"
    } else {
      $failures += "应用没有按要求生成截图(检查 --capture 是否生效)"
      Write-Host "  未找到截图: $shotPath" -ForegroundColor Red
    }
  } else {
    Step '5/5 跳过截图'
  }
} finally {
  if ($app -and (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)) {
    & taskkill /PID $app.Id /T /F 2>&1 | Out-Null
  }
  if ($mock -and (Get-Process -Id $mock.Id -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue
  }
  # 还原原配置
  if ($originalConfig) {
    [System.IO.File]::WriteAllBytes($configPath, $originalConfig)
    Write-Host "`n已还原原 config.json" -ForegroundColor DarkGray
  } elseif (Test-Path $configPath) {
    Remove-Item $configPath -Force
    Write-Host "`n已删除测试用的 config.json" -ForegroundColor DarkGray
  }
}

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host '联调失败:' -ForegroundColor Red
  foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
  exit 1
}
Write-Host '联调通过: 应用能连上网关、状态解析正常、渲染层无异常。' -ForegroundColor Green
exit 0
