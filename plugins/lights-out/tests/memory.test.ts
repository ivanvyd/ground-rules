import { describe, expect, test } from 'claude-code/testing'

import { lowestFree, parseMemory, scanArgv } from '../hooks/memory'

const LINUX = 'MemTotal:       65536000 kB\nMemAvailable:    9830400 kB\n'

const MACOS = [
  'hw.memsize=17179869184',
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                               20000.',
  'Pages active:                            300000.',
  'Pages inactive:                           50000.',
  'Pages speculative:                        30000.',
  '',
].join('\n')

describe('parseMemory', () => {
  test('reads the Windows scan: physical and commit', () => {
    const stdout =
      '{"FreePhysicalMemory":8000000,"TotalVisibleMemorySize":66720420,"FreeVirtualMemory":36785892,"TotalVirtualMemorySize":94117660}'

    expect(parseMemory(stdout, true)).toEqual({ physicalFreePercent: 12, commitFreePercent: 39 })
  })

  test('tolerates a byte-order mark and leading noise before the JSON', () => {
    const stdout = '﻿WARNING: noise\r\n{"FreePhysicalMemory":50,"TotalVisibleMemorySize":100,"FreeVirtualMemory":10,"TotalVirtualMemorySize":100}'

    expect(parseMemory(stdout, true)).toEqual({ physicalFreePercent: 50, commitFreePercent: 10 })
  })

  test('reads /proc/meminfo on Linux', () => {
    expect(parseMemory(LINUX, false)).toEqual({ physicalFreePercent: 15 })
  })

  test('reads vm_stat on macOS, counting inactive and speculative pages as free', () => {
    // (20000 + 50000 + 30000) pages * 16384 bytes of 16 GiB
    expect(parseMemory(MACOS, false)).toEqual({ physicalFreePercent: 10 })
  })
})

describe('parseMemory on output it does not know', () => {
  const rows: Array<[string, string, boolean]> = [
    ['empty Windows output', '', true],
    ['an error message on Windows', 'Get-CimInstance : Access denied', true],
    ['truncated JSON on Windows', '{"FreePhysicalMemory":5', true],
    ['zero total on Windows', '{"FreePhysicalMemory":0,"TotalVisibleMemorySize":0,"FreeVirtualMemory":0,"TotalVirtualMemorySize":0}', true],
    ['empty unix output', '', false],
    ['vm_stat with no memsize', 'Pages free: 10.', false],
  ]

  for (const [name, stdout, isWindows] of rows) {
    test(name, () => {
      expect(parseMemory(stdout, isWindows)).toBeUndefined()
    })
  }
})

describe('lowestFree', () => {
  test('takes the lower of physical and commit', () => {
    expect(lowestFree({ physicalFreePercent: 40, commitFreePercent: 12 })).toBe(12)
    expect(lowestFree({ physicalFreePercent: 8 })).toBe(8)
  })
})

describe('scanArgv', () => {
  const windows = scanArgv(true).join(' ')
  const unix = scanArgv(false).join(' ')

  test('asks for memory totals only', () => {
    expect(windows).toContain('Win32_OperatingSystem')
    expect(windows).not.toMatch(/Win32_Process/)
    expect(unix).not.toMatch(/\bps\b/)
  })

  test('never asks for a command line, a name filter or a kill', () => {
    for (const script of [windows, unix]) {
      expect(script).not.toMatch(/CommandLine|taskkill|pkill|killall|\/IM|Stop-Process|kill /i)
    }
  })
})
