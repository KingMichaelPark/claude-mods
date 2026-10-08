export type Meter = { text: string; percent: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': { meter: Meter | null }
  }
}
