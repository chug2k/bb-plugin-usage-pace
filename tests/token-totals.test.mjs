import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { tokenDelta, sumPeriods, createTokenTotals } from '../lib/token-totals.ts';

test('cumulative reports, duplicates, resets and inherited totals', () => {
  assert.equal(tokenDelta(130, 30, 100), 30);
  assert.equal(tokenDelta(130, 30, 130), 0);
  assert.equal(tokenDelta(20, 20, 130), 20);
  assert.equal(tokenDelta(1000, 40), 40);
  assert.equal(tokenDelta(NaN, 40), 0);
});

test('calendar boundaries use the requested timezone including DST', () => {
  const rows = [
    { createdAt: Date.parse('2026-08-31T20:59:59Z'), tokens: 10 },
    { createdAt: Date.parse('2026-08-31T21:00:00Z'), tokens: 20 },
    { createdAt: Date.parse('2026-09-01T22:00:00Z'), tokens: 30 },
  ];
  assert.deepEqual(sumPeriods(rows, 'Europe/Moscow', Date.parse('2026-09-01T12:00:00Z')), {day:20, month:20});
  const dst = [{createdAt:Date.parse('2026-03-08T05:00:00Z'),tokens:7}];
  assert.deepEqual(sumPeriods(dst,'America/New_York',Date.parse('2026-03-09T03:59:00Z')), {day:7,month:7});
});

test('persistent incremental collection includes archived/hidden and avoids replay', async () => {
  const now = Date.now();
  const rows = [100, 160, 160].map((total, index) => ({
    id: `e${index}`, seq: index+1, threadId:'a', createdAt:now-1000,
    type:'thread/tokenUsage/updated', data:{providerThreadId:'p',tokenUsage:{total:{totalTokens:total},last:{totalTokens:index ? 60 : 100}}},
  }));
  let updates=1;
  const {bb,harness} = createFakePluginHost({pluginId:'token-test',sdk:{threads:{
    list:async(args) => {
      assert.equal(args.includeHidden,true);
      return args.archived ? [{id:'archived',createdAt:now-2000,updatedAt:updates,status:'idle'}] : [{id:'a',createdAt:now-2000,updatedAt:updates,status:'active'}];
    },
    events:{list:async(args)=>args.threadId==='a' ? rows.filter(e=>e.seq>Number(args.afterSeq)) : [
      {id:'archived-1',seq:1,threadId:'archived',createdAt:now-1000,type:'thread/tokenUsage/updated',data:{providerThreadId:'q',tokenUsage:{total:{totalTokens:50},last:{totalTokens:50}}}},
    ].filter(e=>e.seq>Number(args.afterSeq))},
  }}});
  try {
    const get=createTokenTotals(bb);
    assert.equal((await get('UTC',true)).month,210);
    assert.equal((await get('UTC',true)).month,210);
    updates++;
    rows.push({...rows[0],id:'e3',seq:4,data:{providerThreadId:'p',tokenUsage:{total:{totalTokens:200},last:{totalTokens:40}}}});
    assert.equal((await get('UTC',true)).month,250);
  } finally { await harness.lifecycle.dispose(); }
});
