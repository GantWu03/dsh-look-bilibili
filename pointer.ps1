<#
  Persistent Win32 input helper for the DSH desktop window.

  Why this exists: the Bilibili embed player ships its own chrome (title bar,
  seek bar, buttons) and offers no parameter to hide it. It *does* hide after
  ~3s without mouse input, and it reacts to ordinary mouse messages — including
  ones posted straight to the window handle. Posting does not move the real
  cursor, so the app can drive the player without stealing the pointer.

  DSH host plugins run in an `ELECTRON_RUN_AS_NODE` process, which has no access
  to `webContents.sendInputEvent`, so this helper does the Win32 part in a
  separate long-lived process (one Add-Type compile, then ~1ms per message).

  Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
    {"id":1,"action":"info"}
    {"id":2,"action":"move","x":100,"y":200}
    {"id":3,"action":"click","x":100,"y":200}
    {"id":4,"action":"drag","x":10,"y":200,"x2":900,"y2":200}
    {"id":5,"action":"wheel","x":100,"y":200,"delta":-120}
    Coordinates are physical pixels relative to the window's client area.
#>
[CmdletBinding()]
param(
  [long]$Hwnd = 0,
  [string]$Tag = ''
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {}
$OutputEncoding = [Console]::OutputEncoding

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace DshPointer
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    public static class Native
    {
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll")]
        public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint a, uint b, bool attach);

        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr h);

        [DllImport("user32.dll")]
        public static extern IntPtr SetFocus(IntPtr h);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr h, int cmd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr h);

        public static string WindowText(IntPtr h)
        {
            int len = GetWindowTextLength(h);
            var sb = new StringBuilder(len + 2);
            GetWindowText(h, sb, sb.Capacity);
            return sb.ToString();
        }

        public static string ClassName(IntPtr h)
        {
            var sb = new StringBuilder(256);
            GetClassName(h, sb, sb.Capacity);
            return sb.ToString();
        }

        public static List<IntPtr> TopLevel()
        {
            var list = new List<IntPtr>();
            EnumWindows(delegate (IntPtr h, IntPtr p) { list.Add(h); return true; }, IntPtr.Zero);
            return list;
        }
    }
}
'@

# Physical pixels everywhere, regardless of the helper process' own awareness.
try { [void][DshPointer.Native]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch {}

$script:Forced = [IntPtr]$Hwnd
$script:Tag = $Tag
$script:Target = [IntPtr]::Zero
$script:TargetInfo = $null

function Get-ProcessTable {
  $table = @{}
  foreach ($p in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
    $table[[int]$p.ProcessId] = $p
  }
  return $table
}

function Get-AncestorChain {
  param($Table)
  $chain = New-Object System.Collections.Generic.List[int]
  $cur = [int]$PID
  for ($i = 0; $i -lt 12; $i++) {
    $proc = $Table[$cur]
    if (-not $proc) { break }
    [void]$chain.Add($cur)
    $parent = [int]$proc.ParentProcessId
    if ($parent -le 0 -or $parent -eq $cur) { break }
    $cur = $parent
  }
  return $chain
}

function Resolve-Target {
  if ($script:Forced -ne [IntPtr]::Zero) { return $true }
  if ($script:TargetInfo) { return $true }

  $table = Get-ProcessTable
  $chain = Get-AncestorChain -Table $table
  $chainSet = @{}
  foreach ($id in $chain) { $chainSet[[int]$id] = $true }
  $exe = ''
  foreach ($id in $chain) {
    $proc = $table[[int]$id]
    if ($proc -and $proc.ExecutablePath -and [string]$proc.CommandLine -notlike '*--type=*') {
      $exe = [string]$proc.ExecutablePath
      break
    }
  }

  $best = $null
  $bestScore = -1
  $candidates = @()
  foreach ($h in [DshPointer.Native]::TopLevel()) {
    if (-not [DshPointer.Native]::IsWindowVisible($h)) { continue }
    $title = [DshPointer.Native]::WindowText($h)
    $ownerPid = 0
    [void][DshPointer.Native]::GetWindowThreadProcessId($h, [ref]$ownerPid)
    if ($ownerPid -le 0) { continue }
    $cls = [DshPointer.Native]::ClassName($h)
    $proc = $table[[int]$ownerPid]
    $score = 0
    if ($chainSet.ContainsKey([int]$ownerPid)) { $score += 1000 }
    if ($exe -and $proc -and $proc.ExecutablePath -eq $exe) { $score += 400 }
    if ($cls -eq 'Chrome_WidgetWin_1') { $score += 100 }
    if ($title) { $score += 50 }
    if ($script:Tag -and $proc -and [string]$proc.CommandLine -like "*$($script:Tag)*") { $score += 1500 }
    if ($score -le 0) { continue }
    $rect = New-Object DshPointer.RECT
    [void][DshPointer.Native]::GetClientRect($h, [ref]$rect)
    $area = ([int64]($rect.Right - $rect.Left)) * ([int64]($rect.Bottom - $rect.Top))
    $candidates += [pscustomobject]@{ hwnd = $h.ToInt64(); pid = $ownerPid; title = $title; cls = $cls; score = $score; area = $area }
    if ($score -gt $bestScore -or ($score -eq $bestScore -and $best -and $area -gt $best.area)) {
      $bestScore = $score
      $best = [pscustomobject]@{ hwnd = $h.ToInt64(); pid = $ownerPid; title = $title; cls = $cls; score = $score; area = $area }
    }
  }
  if (-not $best) { return $false }
  $script:Target = [IntPtr]$best.hwnd
  $script:TargetInfo = @{
    hwnd   = $best.hwnd
    pid    = $best.pid
    title  = $best.title
    cls    = $best.cls
    score  = $best.score
    chain  = @($chain)
    exe    = $exe
    candidates = @($candidates | Sort-Object -Property score -Descending | Select-Object -First 6)
  }
  return $true
}

function Get-Info {
  if (-not (Resolve-Target)) { return @{ ok = $false; error = 'window not found'; tag = $script:Tag } }
  $h = $script:Target
  $client = New-Object DshPointer.RECT
  [void][DshPointer.Native]::GetClientRect($h, [ref]$client)
  $win = New-Object DshPointer.RECT
  [void][DshPointer.Native]::GetWindowRect($h, [ref]$win)
  $origin = New-Object DshPointer.POINT
  $origin.X = 0; $origin.Y = 0
  [void][DshPointer.Native]::ClientToScreen($h, [ref]$origin)
  $dpi = 96
  try { $dpi = [int][DshPointer.Native]::GetDpiForWindow($h) } catch {}
  $info = @{
    ok = $true
    hwnd = $h.ToInt64()
    hwndHex = ('0x{0:X}' -f $h.ToInt64())
    pid = $script:TargetInfo.pid
    title = $script:TargetInfo.title
    cls = $script:TargetInfo.cls
    score = $script:TargetInfo.score
    chain = $script:TargetInfo.chain
    exe = $script:TargetInfo.exe
    dpi = $dpi
    scale = [Math]::Round($dpi / 96.0, 4)
    client = @{ w = ($client.Right - $client.Left); h = ($client.Bottom - $client.Top) }
    windowRect = @{ x = $win.Left; y = $win.Top; w = ($win.Right - $win.Left); h = ($win.Bottom - $win.Top) }
    clientOrigin = @{ x = $origin.X; y = $origin.Y }
    isForeground = ([DshPointer.Native]::GetForegroundWindow() -eq $h)
    isMinimized = [bool][DshPointer.Native]::IsIconic($h)
  }
  if (-not $script:Tag) { $info['candidates'] = $script:TargetInfo.candidates }
  return $info
}

function Get-LParam {
  param([int]$X, [int]$Y)
  $lo = $X -band 0xFFFF
  $hi = ($Y -band 0xFFFF) -shl 16
  return [IntPtr][int]([int64]$hi -bor [int64]$lo)
}

function Send-Mouse {
  param([uint32]$Msg, [int]$WParam, [int]$X, [int]$Y)
  if (-not (Resolve-Target)) { return $false }
  $lp = Get-LParam -X $X -Y $Y
  return [DshPointer.Native]::PostMessage($script:Target, $Msg, [IntPtr]$WParam, $lp)
}

# Chromium drops synthetic mouse messages while its window is not the active
# one (a real click activates the window first, so the normal path never needs
# this). Windows' foreground lock refuses a plain SetForegroundWindow from a
# background process, so attach to the current foreground thread first.
function Enable-TargetWindow {
  if (-not (Resolve-Target)) { return $false }
  $target = $script:Target
  [void][DshPointer.Native]::ShowWindow($target, 9) # SW_RESTORE
  $fg = [DshPointer.Native]::GetForegroundWindow()
  if ($fg -eq $target) { return $true }
  $fgPid = 0
  $fgThread = [DshPointer.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $myThread = [DshPointer.Native]::GetCurrentThreadId()
  if ($fgThread -ne 0) { [void][DshPointer.Native]::AttachThreadInput($myThread, $fgThread, $true) }
  [void][DshPointer.Native]::BringWindowToTop($target)
  [void][DshPointer.Native]::SetForegroundWindow($target)
  [void][DshPointer.Native]::SetFocus($target)
  if ($fgThread -ne 0) { [void][DshPointer.Native]::AttachThreadInput($myThread, $fgThread, $false) }
  Start-Sleep -Milliseconds 220
  return ([DshPointer.Native]::GetForegroundWindow() -eq $target)
}

$WM_MOUSEMOVE = 0x0200
$WM_LBUTTONDOWN = 0x0201
$WM_LBUTTONUP = 0x0202
$WM_RBUTTONDOWN = 0x0204
$WM_RBUTTONUP = 0x0205
$WM_MOUSEWHEEL = 0x020A
$MK_LBUTTON = 1

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }

  $id = 0
  $reply = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = [int]$req.id
    $action = [string]$req.action
    switch ($action) {
      'info' { $reply = Get-Info }
      'activate' {
        $ok = Enable-TargetWindow
        $reply = @{ ok = [bool]$ok; action = 'activate' }
      }
      'move' {
        $ok = Send-Mouse -Msg $WM_MOUSEMOVE -WParam 0 -X ([int]$req.x) -Y ([int]$req.y)
        $reply = @{ ok = [bool]$ok; action = 'move' }
      }
      'click' {
        $x = [int]$req.x; $y = [int]$req.y
        [void](Enable-TargetWindow)
        [void](Send-Mouse -Msg $WM_MOUSEMOVE -WParam 0 -X $x -Y $y)
        Start-Sleep -Milliseconds 45
        [void](Send-Mouse -Msg $WM_LBUTTONDOWN -WParam $MK_LBUTTON -X $x -Y $y)
        Start-Sleep -Milliseconds 55
        [void](Send-Mouse -Msg $WM_LBUTTONUP -WParam 0 -X $x -Y $y)
        $reply = @{ ok = $true; action = 'click'; x = $x; y = $y }
      }
      'drag' {
        $x1 = [int]$req.x; $y1 = [int]$req.y
        $x2 = if ($null -ne $req.x2) { [int]$req.x2 } else { $x1 }
        $y2 = if ($null -ne $req.y2) { [int]$req.y2 } else { $y1 }
        [void](Enable-TargetWindow)
        $steps = 6
        [void](Send-Mouse -Msg $WM_MOUSEMOVE -WParam 0 -X $x1 -Y $y1)
        Start-Sleep -Milliseconds 45
        [void](Send-Mouse -Msg $WM_LBUTTONDOWN -WParam $MK_LBUTTON -X $x1 -Y $y1)
        Start-Sleep -Milliseconds 40
        for ($i = 1; $i -le $steps; $i++) {
          $mx = [int][Math]::Round($x1 + ($x2 - $x1) * $i / $steps)
          $my = [int][Math]::Round($y1 + ($y2 - $y1) * $i / $steps)
          [void](Send-Mouse -Msg $WM_MOUSEMOVE -WParam $MK_LBUTTON -X $mx -Y $my)
          Start-Sleep -Milliseconds 25
        }
        [void](Send-Mouse -Msg $WM_LBUTTONUP -WParam 0 -X $x2 -Y $y2)
        $reply = @{ ok = $true; action = 'drag'; from = @($x1, $y1); to = @($x2, $y2) }
      }
      'wheel' {
        $delta = if ($null -ne $req.delta) { [int]$req.delta } else { -120 }
        $wparam = ($delta -band 0xFFFF) -shl 16
        $lp = Get-LParam -X ([int]$req.x) -Y ([int]$req.y)
        $ok = $false
        if (Resolve-Target) {
          $ok = [DshPointer.Native]::PostMessage($script:Target, $WM_MOUSEWHEEL, [IntPtr][int]$wparam, $lp)
        }
        $reply = @{ ok = [bool]$ok; action = 'wheel'; delta = $delta }
      }
      'reset' {
        $script:Target = [IntPtr]::Zero
        $script:TargetInfo = $null
        $reply = @{ ok = $true; action = 'reset' }
      }
      default { $reply = @{ ok = $false; error = "unknown action: $action" } }
    }
  } catch {
    $reply = @{ ok = $false; error = [string]$_.Exception.Message; where = [string]$_.InvocationInfo.PositionMessage }
  }
  if ($null -eq $reply) { $reply = @{ ok = $false; error = 'no reply' } }
  $reply['id'] = $id
  try { $reply['hwnd'] = $script:Target.ToInt64() } catch {}
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $reply -Depth 6 -Compress))
  [Console]::Out.Flush()
}
