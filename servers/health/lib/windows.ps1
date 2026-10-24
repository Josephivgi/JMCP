# Collects health facts on Windows and prints one JSON object.
# Every section is wrapped so one failing probe never loses the rest.
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$f = [ordered]@{ os = 'windows' }
function Try-Do($name, [scriptblock]$b) { try { $f[$name] = & $b } catch { $f[$name] = $null } }

Try-Do 'system' {
  $o = Get-CimInstance Win32_OperatingSystem
  $c = Get-CimInstance Win32_ComputerSystem
  [ordered]@{
    hostname = $env:COMPUTERNAME
    caption = $o.Caption; build = $o.BuildNumber
    uptimeSec = [int]((Get-Date) - $o.LastBootUpTime).TotalSeconds
    totalMB = [int]($o.TotalVisibleMemorySize / 1KB); freeMB = [int]($o.FreePhysicalMemory / 1KB)
    model = "$($c.Manufacturer) $($c.Model)"
  }
}

Try-Do 'cpu' {
  $p = @(Get-CimInstance Win32_Processor)
  $t = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
  $q = Get-CimInstance Win32_PerfFormattedData_PerfOS_System
  [ordered]@{
    model = $p[0].Name.Trim(); cores = ($p | Measure-Object NumberOfLogicalProcessors -Sum).Sum
    loadPct = [int]$t.PercentProcessorTime; dpcPct = [int]$t.PercentDPCTime; interruptPct = [int]$t.PercentInterruptTime
    queue = [int]$q.ProcessorQueueLength
    currentMHz = [int]$p[0].CurrentClockSpeed; maxMHz = [int]$p[0].MaxClockSpeed
  }
}

Try-Do 'procs' {
  $cores = [Environment]::ProcessorCount
  Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
    Where-Object { $_.Name -notin '_Total', 'Idle' } |
    Group-Object { $_.Name -replace '#\d+$', '' } |
    ForEach-Object {
      [ordered]@{
        name = $_.Name; count = $_.Count
        cpuPct = [math]::Round((($_.Group | Measure-Object PercentProcessorTime -Sum).Sum) / $cores, 1)
        memMB = [int]((($_.Group | Measure-Object WorkingSetPrivate -Sum).Sum) / 1MB)
      }
    } | Sort-Object { $_.cpuPct * 50 + $_.memMB / 20 } -Descending | Select-Object -First 15
}

Try-Do 'memory' {
  $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
  $pf = @(Get-CimInstance Win32_PageFileUsage)
  [ordered]@{
    commitPct = [int]$m.PercentCommittedBytesInUse
    pagesInPerSec = [int]$m.PageReadsPersec
    hardFaultsPerSec = [int]$m.PageFaultsPersec
    pagefileMB = [int](($pf | Measure-Object AllocatedBaseSize -Sum).Sum)
    pagefileUsedMB = [int](($pf | Measure-Object CurrentUsage -Sum).Sum)
  }
}

Try-Do 'disks' {
  @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    [ordered]@{ mount = $_.DeviceID; totalGB = [math]::Round($_.Size / 1GB, 1); freeGB = [math]::Round($_.FreeSpace / 1GB, 1) }
  })
}

Try-Do 'diskIO' {
  $d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
  [ordered]@{ busyPct = [int][math]::Min(100, $d.PercentDiskTime); queue = [double]$d.CurrentDiskQueueLength; avgSecPerTransfer = [double]$d.AvgDisksecPerTransfer }
}

Try-Do 'physicalDisks' {
  @(Get-PhysicalDisk | ForEach-Object { [ordered]@{ name = $_.FriendlyName; media = "$($_.MediaType)"; bus = "$($_.BusType)"; health = "$($_.HealthStatus)"; sizeGB = [int]($_.Size / 1GB) } })
}

Try-Do 'gpu' {
  @(Get-CimInstance Win32_VideoController | ForEach-Object {
    [ordered]@{ name = $_.Name; driver = $_.DriverVersion; driverDate = if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { $null }; refreshHz = [int]$_.CurrentRefreshRate; status = $_.Status }
  })
}

# Event log counts for the last 7 days.
Try-Do 'events' {
  $since = (Get-Date).AddDays(-7)
  function Count($h) { @(Get-WinEvent -FilterHashtable ($h + @{ StartTime = $since }) -MaxEvents 500 -ErrorAction SilentlyContinue).Count }
  $crashes = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; Id = 1000; StartTime = $since } -MaxEvents 300 -ErrorAction SilentlyContinue |
    ForEach-Object { if ($_.Properties.Count -gt 0) { $_.Properties[0].Value } } | Group-Object | Sort-Object Count -Descending | Select-Object -First 8 | ForEach-Object { [ordered]@{ app = $_.Name; count = $_.Count } })
  $hangs = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Hang'; Id = 1002; StartTime = $since } -MaxEvents 300 -ErrorAction SilentlyContinue |
    ForEach-Object { if ($_.Properties.Count -gt 0) { $_.Properties[0].Value } } | Group-Object | Sort-Object Count -Descending | Select-Object -First 8 | ForEach-Object { [ordered]@{ app = $_.Name; count = $_.Count } })
  [ordered]@{
    days = 7
    unexpectedShutdowns = Count @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 41 }
    bugchecks = Count @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WER-SystemErrorReporting'; Id = 1001 }
    whea = Count @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WHEA-Logger' }
    gpuResets = Count @{ LogName = 'System'; ProviderName = 'Display'; Id = 4101 }
    diskErrors = Count @{ LogName = 'System'; ProviderName = 'disk'; Id = 7, 11, 51, 153 }
    ntfsErrors = Count @{ LogName = 'System'; ProviderName = 'Ntfs'; Id = 55, 98, 137 }
    resourceExhaustion = Count @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Resource-Exhaustion-Detector'; Id = 2004 }
    driverFailures = Count @{ LogName = 'System'; ProviderName = 'Service Control Manager'; Id = 7000, 7001, 7009, 7011, 7031, 7034 }
    appCrashes = $crashes; appHangs = $hangs
  }
}

Try-Do 'power' {
  $scheme = (powercfg /getactivescheme 2>$null) -join ' '
  $b = @(Get-CimInstance Win32_Battery)
  $saver = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power' -Name EnergySaverState -ErrorAction SilentlyContinue).EnergySaverState
  [ordered]@{
    plan = if ($scheme -match '\(([^)]+)\)') { $Matches[1] } else { $scheme }
    hasBattery = $b.Count -gt 0
    onBattery = if ($b.Count) { $b[0].BatteryStatus -eq 1 } else { $false }
    batteryPct = if ($b.Count) { [int]$b[0].EstimatedChargeRemaining } else { $null }
  }
}

Try-Do 'thermal' {
  @(Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature | ForEach-Object { [math]::Round($_.CurrentTemperature / 10 - 273.15, 0) })
}

Try-Do 'pendingReboot' {
  (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or
  (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
}

Try-Do 'startupCount' { @(Get-CimInstance Win32_StartupCommand).Count }

Try-Do 'network' {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  # A name that does not exist is never cached, so it times a full lookup.
  try { $null = [Net.Dns]::GetHostAddresses("jmcp-$(Get-Random).example.com") } catch {}
  $cold = $sw.ElapsedMilliseconds
  $sw.Restart(); try { $null = [Net.Dns]::GetHostAddresses('www.google.com'); $dns = $sw.ElapsedMilliseconds } catch { $dns = $null }
  $pings = @(1..4 | ForEach-Object { $p = New-Object Net.NetworkInformation.Ping; try { $r = $p.Send('1.1.1.1', 1500); if ($r.Status -eq 'Success') { [int]$r.RoundtripTime } else { -1 } } catch { -1 } })
  $ok = @($pings | Where-Object { $_ -ge 0 })
  $is = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  $ad = @(Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object { [ordered]@{ name = $_.Name; desc = $_.InterfaceDescription; speed = $_.LinkSpeed; wifi = ($_.PhysicalMediaType -match '802\.11') } })
  $wifi = (netsh wlan show interfaces 2>$null) -join "`n"
  [ordered]@{
    dnsMs = $dns; dnsMissMs = $cold
    pingMs = if ($ok.Count) { [int](($ok | Measure-Object -Average).Average) } else { $null }
    pingMaxMs = if ($ok.Count) { ($ok | Measure-Object -Maximum).Maximum } else { $null }
    lossPct = [int](100 * ($pings.Count - $ok.Count) / $pings.Count)
    proxy = [bool]$is.ProxyEnable; proxyServer = $is.ProxyServer; pac = $is.AutoConfigURL
    vpn = @($ad | Where-Object { $_.desc -match 'VPN|WireGuard|TAP|Tunnel|OpenVPN|Tailscale|ZeroTier|Cisco|Fortinet|Pulse' } | ForEach-Object { $_.name })
    adapters = $ad
    wifiSignalPct = if ($wifi -match 'Signal\s*:\s*(\d+)%') { [int]$Matches[1] } else { $null }
  }
}

Try-Do 'browsers' {
  $list = @()
  foreach ($b in @(
      @{ name = 'Chrome'; dir = "$env:LOCALAPPDATA\Google\Chrome\User Data"; proc = 'chrome' },
      @{ name = 'Edge'; dir = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"; proc = 'msedge' },
      @{ name = 'Brave'; dir = "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data"; proc = 'brave' })) {
    if (-not (Test-Path $b.dir)) { continue }
    $ls = Get-Content "$($b.dir)\Local State" -Raw | ConvertFrom-Json
    $hw = $ls.hardware_acceleration_mode.enabled
    $prof = Get-ChildItem $b.dir -Directory | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' }
    $ext = 0
    foreach ($p in $prof) { $ext += @(Get-ChildItem "$($p.FullName)\Extensions" -Directory -ErrorAction SilentlyContinue | Where-Object Name -ne 'Temp').Count }
    $procs = @(Get-Process $b.proc -ErrorAction SilentlyContinue)
    $list += [ordered]@{
      name = $b.name; hardwareAcceleration = if ($null -eq $hw) { $true } else { [bool]$hw }
      profiles = @($prof).Count; extensions = $ext
      processes = $procs.Count; memMB = [int](($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
    }
  }
  $ff = "$env:APPDATA\Mozilla\Firefox\Profiles"
  if (Test-Path $ff) {
    $procs = @(Get-Process firefox -ErrorAction SilentlyContinue)
    $ext = 0; foreach ($p in Get-ChildItem $ff -Directory) { $ext += @(Get-ChildItem "$($p.FullName)\extensions" -File -ErrorAction SilentlyContinue).Count }
    $list += [ordered]@{ name = 'Firefox'; hardwareAcceleration = $null; profiles = @(Get-ChildItem $ff -Directory).Count; extensions = $ext; processes = $procs.Count; memMB = [int](($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB) }
  }
  $list
}

Try-Do 'fonts' {
  @(Get-ChildItem "$env:WINDIR\Fonts" -File).Count + @(Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Windows\Fonts" -File -ErrorAction SilentlyContinue).Count
}

Try-Do 'display' {
  Add-Type -AssemblyName System.Windows.Forms
  @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [ordered]@{ width = $_.Bounds.Width; height = $_.Bounds.Height; primary = $_.Primary } })
}

$f | ConvertTo-Json -Depth 6 -Compress
