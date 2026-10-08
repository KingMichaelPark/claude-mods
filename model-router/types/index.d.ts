export type Mode = 'auto' | 'off' | 'opus' | 'sonnet' | 'haiku'

declare module 'claude-code' {
  interface PluginState {
    'model-router': { mode: Mode }
  }
}
