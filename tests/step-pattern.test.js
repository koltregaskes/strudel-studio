import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../step-pattern.js', import.meta.url), 'utf8')
const loaded = await import(`data:text/javascript,${encodeURIComponent(source)}`)
void loaded

const { parseStepList, rejectedStepTokens } = globalThis.strudelStepPattern

test('keeps unique steps from 1 to 16 in order', () => {
    assert.deepEqual(parseStepList(' 16, 8, 8, 1 '), [1, 8, 16])
    assert.deepEqual(rejectedStepTokens(' 16, 8, 8, 1 '), [])
})

test('rejects values outside 1-16 and partial numbers', () => {
    assert.deepEqual(parseStepList('0, 17, foo, 8.5, 8abc, 08, 4'), [4])
    assert.deepEqual(rejectedStepTokens('0, 17, foo, 8.5, 8abc, 08, 4'), ['0', '17', 'foo', '8.5', '8abc', '08'])
})

test('treats an empty field as no steps', () => {
    assert.deepEqual(parseStepList(' , , '), [])
    assert.deepEqual(rejectedStepTokens(''), [])
})
