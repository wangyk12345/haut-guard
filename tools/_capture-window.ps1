<#
.SYNOPSIS
  截取指定进程主窗口的屏幕区域(真实桌面合成结果, 含窗口透明与系统特效)。

.DESCRIPTION
  Electron 的 webContents.capturePage() 只能截到页面内容, 看不到"窗口背后透出的
  桌面", 因此验收玻璃/透明效果必须用系统级截图。
  同时输出一张整屏截图, 便于判断窗口在桌面上的实际观感。

.EXAMPLE
  pwsh -File tools\_capture-window.ps1 -ProcessName electron -Out docs\ui\real-online.png
#>
[CmdletBinding()]
param(
  [string]$ProcessName = 'electron',
  # 优先按 PID 定位: 同机上可能同时有别的 Electron 进程(例如界面预览工具)
  [int]$ProcessId = 0,
  [string]$TitleFilter = '',
  [string]$Out = 'docs\ui\real-window.png',
  [int]$WaitMs = 2500,
  [switch]$FullScreenOnly
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
}
"@

function Save-Rect([int]$x, [int]$y, [int]$w, [int]$h, [string]$path) {
  if ($w -le 0 -or $h -le 0) { throw "无效的截图区域: ${w}x${h}" }
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    } finally { $g.Dispose() }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bmp.Dispose() }
  return (Get-Item $path).Length
}

Start-Sleep -Milliseconds $WaitMs

# 整屏截图(便于看窗口在桌面上的真实观感)
if ($FullScreenOnly) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $size = Save-Rect $vs.Left $vs.Top $vs.Width $vs.Height $Out
  Write-Host "整屏截图已保存: $Out ($size bytes, $($vs.Width)x$($vs.Height))"
  return
}

# 找到目标进程的主窗口
if ($ProcessId -gt 0) {
  # Electron 的窗口由主(browser)进程持有, 所以给了 PID 就只认它 ——
  # 混入同名进程会抓到别的 Electron 应用(例如界面预览工具)。
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { throw "进程 $ProcessId 不存在" }
  $candidates = @($proc)
} else {
  $candidates = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
}
$candidates = $candidates | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }
if ($TitleFilter) {
  $candidates = $candidates | Where-Object { $_.MainWindowTitle -like "*$TitleFilter*" }
}
if (-not $candidates) {
  throw "没有找到匹配的可见窗口 (进程=$ProcessName pid=$ProcessId 标题过滤='$TitleFilter')"
}

$target = $candidates | Sort-Object Id | Select-Object -First 1
$hWnd = $target.MainWindowHandle
[void][WinCap]::SetForegroundWindow($hWnd)
Start-Sleep -Milliseconds 700

$rect = New-Object WinCap+RECT
if (-not [WinCap]::GetWindowRect($hWnd, [ref]$rect)) { throw "GetWindowRect 失败" }
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top

$title = New-Object System.Text.StringBuilder 256
[void][WinCap]::GetWindowText($hWnd, $title, 256)

Write-Host "窗口: pid=$($target.Id) 标题='$($title.ToString())' 位置=($($rect.Left),$($rect.Top)) 尺寸=${w}x${h}"

$size = Save-Rect $rect.Left $rect.Top $w $h $Out
Write-Host "窗口截图已保存: $Out ($size bytes)"
