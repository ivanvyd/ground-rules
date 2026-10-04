// Free machine memory, read with one short host command per scan. The scan
// asks for memory totals only: no process list, no command lines, no paths.

export type Memory = {
  /** Free physical memory, 0 to 100. */
  physicalFreePercent: number
  /** Free commit charge (Windows only), 0 to 100. */
  commitFreePercent?: number
}

const percent = (free: number, total: number): number | undefined =>
  total > 0 ? Math.round((free / total) * 100) : undefined

const WINDOWS_SCRIPT =
  'Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory,TotalVisibleMemorySize,FreeVirtualMemory,TotalVirtualMemorySize | ' +
  'Select-Object FreePhysicalMemory,TotalVisibleMemorySize,FreeVirtualMemory,TotalVirtualMemorySize | ConvertTo-Json -Compress'

const UNIX_SCRIPT =
  'if [ -r /proc/meminfo ]; then grep -E "^(MemTotal|MemAvailable):" /proc/meminfo; ' +
  'else echo "hw.memsize=$(sysctl -n hw.memsize)"; vm_stat; fi'

export const scanArgv = (isWindows: boolean): string[] =>
  isWindows
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT]
    : ['sh', '-c', UNIX_SCRIPT]

type WindowsMemory = {
  FreePhysicalMemory: number
  TotalVisibleMemorySize: number
  FreeVirtualMemory: number
  TotalVirtualMemorySize: number
}

const WINDOWS_FIELDS = ['FreePhysicalMemory', 'TotalVisibleMemorySize', 'FreeVirtualMemory', 'TotalVirtualMemorySize'] as const

function isWindowsMemory(value: unknown): value is WindowsMemory {
  return typeof value === 'object' && value !== null && WINDOWS_FIELDS.every(field => typeof Reflect.get(value, field) === 'number')
}

function parseWindows(stdout: string): Memory | undefined {
  const start = stdout.indexOf('{')
  if (start === -1) return undefined

  let os: unknown
  try {
    os = JSON.parse(stdout.slice(start))
  } catch {
    return undefined
  }
  if (!isWindowsMemory(os)) return undefined

  const physical = percent(os.FreePhysicalMemory, os.TotalVisibleMemorySize)
  const commit = percent(os.FreeVirtualMemory, os.TotalVirtualMemorySize)
  if (physical === undefined) return undefined
  return commit === undefined
    ? { physicalFreePercent: physical }
    : { physicalFreePercent: physical, commitFreePercent: commit }
}

function parseVmStat(stdout: string, totalBytes: number): Memory | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1])
  const pages = (label: string): number =>
    Number(new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm').exec(stdout)?.[1] ?? 0)
  if (!pageSize) return undefined

  // macOS counts inactive and speculative pages as available.
  const freePages = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')
  const free = percent(freePages * pageSize, totalBytes)
  return free === undefined ? undefined : { physicalFreePercent: free }
}

function parseUnix(stdout: string): Memory | undefined {
  const total = Number(/^MemTotal:\s+(\d+) kB/m.exec(stdout)?.[1])
  const available = Number(/^MemAvailable:\s+(\d+) kB/m.exec(stdout)?.[1])
  if (total && available) {
    const free = percent(available, total)
    return free === undefined ? undefined : { physicalFreePercent: free }
  }

  const memsize = Number(/^hw\.memsize=(\d+)/m.exec(stdout)?.[1])
  return memsize ? parseVmStat(stdout, memsize) : undefined
}

/** Memory from the output of the scan command, or undefined when it isn't recognisable. */
export const parseMemory = (stdout: string, isWindows: boolean): Memory | undefined =>
  isWindows ? parseWindows(stdout) : parseUnix(stdout)

/** The lower of the physical and commit figures: the one closer to trouble. */
export const lowestFree = (memory: Memory): number =>
  Math.min(memory.physicalFreePercent, memory.commitFreePercent ?? 100)
