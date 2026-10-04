export type Mode = 'teach' | 'watch' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'stay-put': {
      mode: Mode
      /** Directory-change chains seen this session. */
      caught: number
      /** Bounced chains whose next shell call ran without the directory change. */
      fixed: number
      /** True from a bounce until the next shell call. */
      isAwaitingFix: boolean
      /** True from a bounce until the next prompt, while the band shows. */
      isRecent: boolean
    }
  }
}
