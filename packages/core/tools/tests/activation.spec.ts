/** Registration conditions and scoped filters share frozen step admission with execution. */
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, TOOL_ABORTED_BEFORE_DISPATCH, ToolActivationError } from '@deepseek-ai/dsh-tools'
import type { ToolActivationContext, ToolActivationFilter, ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

const TEST_MODEL_SELECTION = { provider: 'test', model: 'test' }
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const agent = { id: SessionId('activation') } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  const controller = new AbortController()
  let calls = 0
  const tool = defineTool({
    name: 'conditional', description: 'A conditional operation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { calls++; return 'done' },
  })
  const input = { agent, name: tool.name, arguments: {}, callId: ToolCallId('call'), signal: controller.signal }
  const execute = (overrides: Partial<ToolExecutionInput> = {}): Promise<ToolExecutionResult> =>
    executeToolFixture(ctx, { ...input, ...overrides })
  const resolve = () => ctx.tools.resolve({ agent, modelSelection: TEST_MODEL_SELECTION, signal: controller.signal })
  return { ctx, agent, scope, controller, tool, input, execute, resolve, calls: () => calls }
}

it('activates and deactivates a registered tool without allowing historical calls', async () => {
  const h = await setup()
  let enabled = false
  h.ctx.tools.register(h.tool, { when: () => enabled })
  const unavailable = await h.resolve()
  expect(h.ctx.tools.schemas(h.agent, unavailable)).toEqual([])
  enabled = true
  expect((await h.execute({ toolSet: unavailable })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect((await h.execute()).error?.info?.code).toBe('UNKNOWN_TOOL')
  const available = await h.resolve()
  expect(h.ctx.tools.schemas(h.agent, available).map(tool => tool.name)).toEqual(['conditional'])
  expect((await h.execute({ toolSet: available })).isError).toBe(false)
  enabled = false
  const disabled = await h.resolve()
  expect((await h.execute({ toolSet: disabled })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls()).toBe(1)
})

it('applies a batch admission to the calls its executor runs', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool, { when: () => true })
  const toolSet = await h.resolve()
  expect((await executeModelToolFixture(h.ctx, { ...h.input, toolSet })).isError).toBe(false)
  expect((await executeModelToolFixture(h.ctx, h.input)).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls()).toBe(1)
})

it('keeps admissions specific to the requesting agent', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool, { when: () => true })
  const toolSet = await h.resolve()
  const other = { id: SessionId('other') } as Agent
  expect((await h.execute({ agent: other, toolSet })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls()).toBe(0)
})

it('applies live restrictions and closes step admission permanently', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool, { when: () => true })
  const toolSet = await h.resolve()
  const lift = h.scope.ctx.tools.restrict({ deny: ['conditional'] })
  expect((await h.execute({ toolSet })).error?.info?.code).toBe('UNKNOWN_TOOL')
  lift()
  expect((await h.execute({ toolSet })).isError).toBe(false)
  toolSet.dispose()
  expect(h.ctx.tools.schemas(h.agent, toolSet)).toEqual([])
  expect((await h.execute({ toolSet })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls()).toBe(1)
})

it('settles calls of a cancelled step through cancellation with their finalizers', async () => {
  const h = await setup()
  h.ctx.tools.register({ ...h.tool, finalizeContent: () => [{ type: 'text', text: 'finalized' }] }, { when: () => true })
  const toolSet = await h.resolve()
  h.controller.abort()
  const result = await h.execute({ toolSet })
  expect(result.error?.info?.code).toBe(TOOL_ABORTED_BEFORE_DISPATCH)
  expect(result.content).toEqual([{ type: 'text', text: 'finalized' }])
  expect(h.calls()).toBe(0)
})

it('reports a wrapper result completed at cancellation as cancelled rather than unknown', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool, { when: () => true })
  const toolSet = await h.resolve()
  h.ctx.on('tools/execute', async () => {
    h.controller.abort()
    return { isError: false, value: 'wrapped', content: [{ type: 'text', text: 'wrapped' }] }
  })
  expect((await h.execute({ toolSet })).error?.info?.code).toBe(TOOL_ABORTED_BEFORE_DISPATCH)
})

it('does not substitute a same-name registration after admission', async () => {
  const h = await setup()
  const unregister = h.ctx.tools.register(h.tool, { when: () => true })
  const old = await h.resolve()
  unregister()
  h.ctx.tools.register(h.tool, { when: () => true })
  expect((await h.execute({ toolSet: old })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect((await h.execute({ toolSet: await h.resolve() })).isError).toBe(false)
  expect(h.calls()).toBe(1)
})

it('does not restore a registration removed during its asynchronous condition', async () => {
  const h = await setup()
  const condition = Promise.withResolvers<boolean>()
  const entered = Promise.withResolvers<undefined>()
  const unregister = h.ctx.tools.register(h.tool, { when: () => { entered.resolve(undefined); return condition.promise } })
  const pending = h.resolve()
  await entered.promise
  unregister()
  condition.resolve(true)
  const toolSet = await pending
  expect(h.ctx.tools.schemas(h.agent, toolSet)).toEqual([])
  expect((await h.execute({ toolSet })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls()).toBe(0)
})

it('propagates cancellation after an asynchronous condition settles', async () => {
  const h = await setup()
  const condition = Promise.withResolvers<boolean>()
  h.ctx.tools.register(h.tool, { when: ({ agent, modelSelection, signal }) => {
    expect(agent).toBe(h.agent)
    expect(modelSelection).toBe(TEST_MODEL_SELECTION)
    expect(signal).toBe(h.controller.signal)
    return condition.promise
  } })
  const pending = h.resolve()
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  h.controller.abort()
  condition.resolve(true)
  await rejection
  expect(h.calls()).toBe(0)
})

it('filters inherited and own-scope tools without changing registered definitions', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool)
  h.scope.ctx.tools.register({ ...h.tool, name: 'own' })
  const when = vi.fn(() => false)
  h.scope.ctx.tools.activationFilter({ matches: () => true, when })
  const toolSet = await h.resolve()
  expect(h.ctx.tools.definitions(h.agent).map(tool => tool.name)).toEqual(['conditional', 'own'])
  expect(h.ctx.tools.schemas(h.agent, toolSet)).toEqual([])
  expect((await h.execute({ toolSet })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect((await h.execute({ name: 'own', toolSet })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(when).toHaveBeenCalledTimes(2)
  expect(h.calls()).toBe(0)
})

it('inherits ancestor filters without leaking an agent filter to sibling agents', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool)
  const parent = { id: SessionId('parent') } as Agent
  const child = { id: SessionId('child') } as Agent
  const sibling = { id: SessionId('sibling') } as Agent
  let parentScope!: Scope
  let childScope!: Scope
  await h.ctx.plugin(Object.assign((inner: Context) => {
    parentScope = createScope(inner, parent)
    childScope = createScope(inner, child, { parent })
    createScope(inner, sibling, { parent })
  }, { inject: ['tools'] }))
  let parentEnabled = true
  parentScope.ctx.tools.activationFilter({ matches: () => true, when: () => parentEnabled })
  childScope.ctx.tools.activationFilter({ matches: () => true, when: () => false })
  const resolve = (agent: Agent) => h.ctx.tools.resolve({
    agent, modelSelection: TEST_MODEL_SELECTION, signal: h.controller.signal,
  })
  expect(h.ctx.tools.schemas(child, await resolve(child))).toEqual([])
  expect(h.ctx.tools.schemas(sibling, await resolve(sibling))).toHaveLength(1)
  parentEnabled = false
  expect(h.ctx.tools.schemas(sibling, await resolve(sibling))).toEqual([])
  expect(h.ctx.tools.schemas(h.agent, await h.resolve())).toHaveLength(1)
})

it('intersects registration, global, and own-scope activation conditions', async () => {
  const h = await setup()
  let registration = false
  let global = true
  let own = true
  h.scope.ctx.tools.register(h.tool, { when: () => registration })
  h.ctx.tools.activationFilter({ matches: () => true, when: () => global })
  h.scope.ctx.tools.activationFilter({ matches: () => true, when: () => own })
  for (const [registered, globallyEnabled, ownEnabled, expected] of [
    [false, true, true, false],
    [true, false, true, false],
    [true, true, false, false],
    [true, true, true, true],
  ] as const) {
    registration = registered
    global = globallyEnabled
    own = ownEnabled
    const toolSet = await h.resolve()
    expect(h.ctx.tools.schemas(h.agent, toolSet)).toHaveLength(expected ? 1 : 0)
  }
})

it('removes an activation filter when its contributing plugin fiber unloads', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool)
  const fiber = h.ctx.plugin(Object.assign((inner: Context) => {
    inner.tools.activationFilter({ matches: () => true, when: () => false })
  }, { inject: ['tools'] }))
  await fiber
  const denied = await h.resolve()
  expect(h.ctx.tools.schemas(h.agent, denied)).toEqual([])
  await fiber.dispose()
  expect(h.ctx.tools.schemas(h.agent, await h.resolve())).toHaveLength(1)
  expect((await h.execute()).isError).toBe(false)
  expect(h.ctx.tools.schemas(h.agent, denied)).toEqual([])
})

it('denies filter-matched direct calls without evaluating their activation condition', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool)
  h.ctx.tools.register({ ...h.tool, name: 'unmatched' })
  const when = vi.fn(async () => true)
  h.ctx.tools.activationFilter({ matches: definition => definition.name === h.tool.name, when })
  expect(h.ctx.tools.executable(h.tool.name)).toBeUndefined()
  expect(h.ctx.tools.executable(h.tool.name, h.agent)).toBeUndefined()
  expect((await h.execute()).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect((await executeModelToolFixture(h.ctx, h.input)).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(when).not.toHaveBeenCalled()
  expect((await h.execute({ name: 'unmatched' })).isError).toBe(false)
  const toolSet = await h.resolve()
  expect(h.ctx.tools.get(h.tool.name, h.agent, toolSet)).toBe(h.tool)
  expect((await h.execute({ toolSet })).isError).toBe(false)
  expect(when).toHaveBeenCalledOnce()
  expect(h.calls()).toBe(2)
})

it('freezes filter admission while retaining live identity and restriction checks', async () => {
  const h = await setup()
  const unregister = h.ctx.tools.register(h.tool)
  let enabled = true
  const when = vi.fn(() => enabled)
  h.ctx.tools.activationFilter({ matches: () => true, when })
  const admitted = await h.resolve()
  enabled = false
  expect((await h.execute({ toolSet: admitted })).isError).toBe(false)
  const denied = await h.resolve()
  h.scope.ctx.tools.activationFilter({ matches: () => false, when: () => false })
  expect((await h.execute({ toolSet: admitted })).isError).toBe(false)
  expect((await h.execute({ toolSet: denied })).error?.info?.code).toBe('UNKNOWN_TOOL')
  const lift = h.scope.ctx.tools.restrict({ deny: [h.tool.name] })
  expect((await h.execute({ toolSet: admitted })).error?.info?.code).toBe('UNKNOWN_TOOL')
  lift()
  expect((await h.execute({ toolSet: admitted })).isError).toBe(false)
  unregister()
  h.ctx.tools.register(h.tool)
  expect((await h.execute({ toolSet: admitted })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(when).toHaveBeenCalledTimes(2)
  expect(h.calls()).toBe(3)
})

it('passes the selected definition to one filter for per-tool decisions', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool)
  const other = { ...h.tool, name: 'other' }
  h.ctx.tools.register(other)
  const when = vi.fn((_context: ToolActivationContext, definition: typeof h.tool) => definition === other)
  h.ctx.tools.activationFilter({ matches: () => true, when })
  const toolSet = await h.resolve()
  expect(h.ctx.tools.schemas(h.agent, toolSet).map(tool => tool.name)).toEqual(['other'])
  expect(when.mock.calls.map(call => call[1])).toEqual([h.tool, other])
})

it('invalidates only matching admissions when activation filters change', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool)
  h.ctx.tools.register({ ...h.tool, name: 'unmatched' })
  const old = await h.resolve()
  const filter: ToolActivationFilter = { matches: tool => tool.name === h.tool.name, when: () => true }
  const dispose = h.ctx.tools.activationFilter(filter)
  expect((await h.execute({ toolSet: old })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect((await h.execute({ name: 'unmatched', toolSet: old })).isError).toBe(false)
  const admitted = await h.resolve()
  dispose()
  expect((await h.execute({ toolSet: admitted })).error?.info?.code).toBe('UNKNOWN_TOOL')
  h.ctx.tools.activationFilter(filter)
  expect((await h.execute({ toolSet: admitted })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect((await h.execute({ name: 'unmatched', toolSet: admitted })).isError).toBe(false)
  const other = { id: SessionId('unrelated') } as Agent
  let otherScope!: Scope
  await h.ctx.plugin(Object.assign((inner: Context) => { otherScope = createScope(inner, other) }, { inject: ['tools'] }))
  const current = await h.resolve()
  otherScope.ctx.tools.activationFilter({ matches: () => true, when: () => false })
  expect((await h.execute({ toolSet: current })).isError).toBe(false)
})

it('rejects dispatch on a classifier failure while verifying an admitted set', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool)
  let fail = false
  const cause = new Error('classifier unavailable')
  h.ctx.tools.activationFilter({ matches: () => {
    if (fail) throw cause
    return true
  }, when: () => true })
  const toolSet = await h.resolve()
  fail = true
  expect(() => h.ctx.tools.executable(h.tool.name, h.agent, toolSet)).toThrow(ToolActivationError)
  await expect(h.execute({ toolSet })).rejects.toMatchObject({
    name: ToolActivationError.name, code: 'TOOL_ACTIVATION_FAILED', cause,
  })
  expect(h.calls()).toBe(0)
})

it('rejects a late admission when a matching filter was replaced in flight', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool)
  const condition = Promise.withResolvers<boolean>()
  const entered = Promise.withResolvers<undefined>()
  const dispose = h.ctx.tools.activationFilter({ matches: () => true, when: () => {
    entered.resolve(undefined)
    return condition.promise
  } })
  const pending = h.resolve()
  await entered.promise
  dispose()
  h.ctx.tools.activationFilter({ matches: () => true, when: () => false })
  condition.resolve(true)
  const toolSet = await pending
  expect((await h.execute({ toolSet })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.ctx.tools.schemas(h.agent, await h.resolve())).toEqual([])
})

it.each(['matches', 'when'] as const)('reports activation filter %s failures as preparation failures', async (stage) => {
  const h = await setup()
  h.ctx.tools.register(h.tool)
  const cause = new Error('activation unavailable')
  const filter: ToolActivationFilter = { matches: () => true, when: () => true }
  filter[stage] = () => { throw cause }
  h.ctx.tools.activationFilter(filter)
  await expect(h.resolve()).rejects.toMatchObject({
    name: ToolActivationError.name, code: 'TOOL_ACTIVATION_FAILED', cause,
  })
  if (stage === 'matches') {
    expect(() => h.ctx.tools.executable(h.tool.name, h.agent)).toThrow(ToolActivationError)
  }
  expect(h.calls()).toBe(0)
})

it.each([false, true])('preserves cancellation over a settled filter condition (rejected: %s)', async (reject) => {
  const h = await setup()
  h.ctx.tools.register(h.tool)
  const condition = Promise.withResolvers<boolean>()
  const entered = Promise.withResolvers<undefined>()
  const when = vi.fn(({ agent, modelSelection, signal }: ToolActivationContext) => {
    expect(agent).toBe(h.agent)
    expect(modelSelection).toBe(TEST_MODEL_SELECTION)
    expect(signal).toBe(h.controller.signal)
    entered.resolve(undefined)
    return condition.promise
  })
  h.ctx.tools.activationFilter({ matches: () => true, when })
  const pending = h.resolve()
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await entered.promise
  h.controller.abort()
  if (reject) condition.reject(new Error('condition aborted'))
  else condition.resolve(true)
  await rejection
  await expect(h.resolve()).rejects.toMatchObject({ name: 'AbortError' })
  expect(when).toHaveBeenCalledOnce()
  expect(h.calls()).toBe(0)
})

it('reports condition failures without treating them as disabled tools', async () => {
  const h = await setup()
  const cause = new Error('credential storage unavailable')
  h.ctx.tools.register(h.tool, { when: () => { throw cause } })
  await expect(h.resolve()).rejects.toMatchObject({
    name: ToolActivationError.name, code: 'TOOL_ACTIVATION_FAILED', cause,
  })
  expect(h.calls()).toBe(0)
})
