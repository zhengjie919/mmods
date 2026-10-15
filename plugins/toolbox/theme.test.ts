import { test, expect } from 'claude-code/testing'
import { segCells , statusHex } from './hooks/theme'

test('segCells fills n cells, gives every non-empty part one, leaves the rest empty', () => {
  const cells = segCells([8_000, 14_000, 120_000, 1], 1_000_000, 0, 20)
  expect(cells).toHaveLength(20)
  expect(cells.filter(c => c.ch === '█').length).toBeGreaterThanOrEqual(4)
  expect(cells.filter(c => c.ch === '░').length).toBeGreaterThan(10)
})

test('segCells never exceeds n when parts overflow the window', () => {
  expect(segCells([900, 900], 1000, 0, 10)).toHaveLength(10)
})

test('statusHex runs deeper to light, green for success and rose for failure', () => {
  expect(statusHex(true, 0)).toBe('#4ade80')
  expect(statusHex(true, 1)).toBe('#bbf7d0')
  expect(statusHex(false, 0)).toBe('#fb7185')
  expect(statusHex(false, 1)).toBe('#fecdd3')
})
