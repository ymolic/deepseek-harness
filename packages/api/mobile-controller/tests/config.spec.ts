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
