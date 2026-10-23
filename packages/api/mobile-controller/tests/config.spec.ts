/** Deployment-controlled download admission remains bounded. */
import { expect, it } from 'vitest'
import { MobileController } from '../src/index.ts'

it('defaults to 32 download fragments and validates the configurable flight size', () => {
  expect(MobileController.Config({} as never).fullFragmentWindow).toBe(32)
  for (const fullFragmentWindow of [1, 8, 32]) {
    expect(MobileController.Config({ fullFragmentWindow } as never).fullFragmentWindow).toBe(fullFragmentWindow)
  }
  for (const fullFragmentWindow of [0, 33, 1.5]) {
    expect(() => MobileController.Config({ fullFragmentWindow } as never)).toThrow()
  }
})

it('validates the stream compression threshold within the application packet limit', () => {
  expect(MobileController.Config({} as never).fullCompressionMinBytes).toBe(32768)
  for (const fullCompressionMinBytes of [1024, 32768, 16 * 1024 * 1024]) {
    expect(MobileController.Config({ fullCompressionMinBytes } as never).fullCompressionMinBytes).toBe(fullCompressionMinBytes)
  }
  for (const fullCompressionMinBytes of [0, 1023, 1.5, 16 * 1024 * 1024 + 1]) {
    expect(() => MobileController.Config({ fullCompressionMinBytes } as never)).toThrow()
  }
})
