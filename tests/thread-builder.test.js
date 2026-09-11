import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildThreadsFromRows, MAX_MESSAGES_PER_THREAD } from '../src/services/thread.builder.js';
import { normalizeTweetRow, streamTweetRows, cleanId } from '../src/services/dataset.parser.js';

/** Build one normalised row the way the CSV scanner would. */
function row(tweetId, authorId, text, { parent = '', responses = '', minutes = 0 } = {}) {
  return normalizeTweetRow(
    {
      tweet_id: String(tweetId),
      author_id: authorId,
      text,
      created_at: new Date(Date.UTC(2020, 9, 5, 8, minutes)).toISOString(),
      in_response_to_tweet_id: parent,
      response_tweet_id: responses,
    },
    tweetId,
  );
}

/** Turn rows into the `Map` the builder expects. */
function rowMap(rows) {
  return new Map(rows.map((entry) => [entry.tweetId, entry]));
}

describe('thread reconstruction', () => {
  it('links a customer message to the brand reply that answers it', () => {
    const rows = rowMap([
      row(1, 'customer_a', 'Where is my order?', { minutes: 0 }),
      row(2, 'AmazonHelp', 'Send the order number please.', { parent: 1, responses: 1, minutes: 1 }),
    ]);

    const { threads, stats } = buildThreadsFromRows(rows);

    assert.equal(threads.length, 1);
    assert.equal(threads[0].threadId, '1');
    assert.equal(threads[0].brand, 'Amazon');
    assert.deepEqual(
      threads[0].messages.map((message) => message.role),
      ['customer', 'agent'],
    );
    assert.equal(stats.threadsBuilt, 1);
  });

  it('orders messages by timestamp, not by file order', () => {
    // Deliberately inserted out of order: the chain is 1 → 2 → 3.
    const rows = rowMap([
      row(3, 'AmazonHelp', 'Agent reply', { parent: 2, minutes: 3 }),
      row(1, 'customer_a', 'First message', { minutes: 0 }),
      row(2, 'customer_a', 'Follow-up', { parent: 1, minutes: 1 }),
    ]);

    const [thread] = buildThreadsFromRows(rows).threads;

    assert.deepEqual(
      thread.messages.map((message) => message.text),
      ['First message', 'Follow-up', 'Agent reply'],
    );
  });

  it('merges multi-id reply links into one thread (union-find)', () => {
    const rows = rowMap([
      row(10, 'customer_a', 'problem one', { minutes: 0 }),
      row(11, 'customer_b', 'problem two', { minutes: 1 }),
      row(12, 'AmazonHelp', 'answering both', { responses: '10,11', minutes: 2 }),
    ]);

    const { threads } = buildThreadsFromRows(rows);

    assert.equal(threads.length, 1, 'both customer tweets join the same component');
    assert.equal(threads[0].messages.length, 3);
  });

  it('drops a component with no brand reply', () => {
    const rows = rowMap([
      row(20, 'customer_a', 'nobody answered me', { minutes: 0 }),
      row(21, 'customer_a', 'still waiting', { parent: 20, minutes: 1 }),
    ]);

    const { threads, stats } = buildThreadsFromRows(rows);

    assert.equal(threads.length, 0);
    assert.equal(stats.dropped.noBrand, 1);
  });

  it('drops a brand-only component', () => {
    const rows = rowMap([row(30, 'AmazonHelp', 'broadcast with no customer message', { minutes: 0 })]);

    const { threads, stats } = buildThreadsFromRows(rows);

    assert.equal(threads.length, 0);
    assert.equal(stats.dropped.noCustomer, 1);
  });

  it('drops components merged beyond the size guard', () => {
    const rows = [row(40, 'customer_a', 'root message', { minutes: 0 })];
    for (let index = 1; index <= MAX_MESSAGES_PER_THREAD; index += 1) {
      rows.push(row(40 + index, index % 2 === 0 ? 'AmazonHelp' : 'customer_a', `message ${index}`, { parent: 40 + index - 1, minutes: index }));
    }

    const { threads, stats } = buildThreadsFromRows(rowMap(rows));

    assert.equal(threads.length, 0);
    assert.equal(stats.dropped.tooLarge, 1, 'over-merged components are discarded, not truncated');
  });

  it('keeps a thread whose parent id is dangling', () => {
    const rows = rowMap([
      row(50, 'customer_a', 'parcel left at the wrong address', { parent: 999999, minutes: 0 }),
      row(51, 'AmazonHelp', 'send the order number', { parent: 50, minutes: 1 }),
    ]);

    const { threads } = buildThreadsFromRows(rows);

    assert.equal(threads.length, 1, 'a missing parent must not lose the conversation');
    assert.equal(threads[0].messages.length, 2);
  });

  it('does not repeat consecutive identical messages of the same role', () => {
    const rows = rowMap([
      row(60, 'customer_a', 'same text', { minutes: 0 }),
      row(61, 'customer_a', 'same text', { parent: 60, minutes: 1 }),
      row(62, 'AmazonHelp', 'agent reply', { parent: 61, minutes: 2 }),
    ]);

    const [thread] = buildThreadsFromRows(rows).threads;

    assert.equal(thread.messages.length, 2);
  });

  it('honours the thread cap and orders newest-first', () => {
    const rows = [
      row(70, 'customer_a', 'older', { minutes: 0 }),
      row(71, 'AmazonHelp', 'reply to older', { parent: 70, minutes: 1 }),
      row(80, 'customer_b', 'newer', { minutes: 30 }),
      row(81, 'AmazonHelp', 'reply to newer', { parent: 80, minutes: 31 }),
    ];

    const { threads } = buildThreadsFromRows(rowMap(rows), { maxThreads: 1 });

    assert.equal(threads.length, 1);
    assert.equal(threads[0].threadId, '80', 'the most recently active thread is kept');
  });

  it('finds the first customer message even when the brand replies first', () => {
    const rows = rowMap([
      row(90, 'AmazonHelp', 'generic acknowledgement', { minutes: 0 }),
      row(91, 'customer_a', 'the actual problem', { parent: 90, minutes: 1 }),
    ]);

    const [thread] = buildThreadsFromRows(rows).threads;

    assert.equal(thread.messages[0].role, 'agent');
    assert.equal(thread.messages[1].role, 'customer');
  });
});

describe('row normalisation', () => {
  it('rejects rows with no id, no author, no text or no usable date', () => {
    const base = { tweet_id: '1', author_id: 'a', text: 'hello there', created_at: '2020-10-05T08:00:00.000Z' };

    assert.equal(normalizeTweetRow({ ...base, tweet_id: '' }, 1), null);
    assert.equal(normalizeTweetRow({ ...base, author_id: '' }, 1), null);
    assert.equal(normalizeTweetRow({ ...base, text: '   ' }, 1), null);
    assert.equal(normalizeTweetRow({ ...base, created_at: 'not-a-date' }, 1), null);
    assert.ok(normalizeTweetRow(base, 1));
  });

  it('decodes entities, strips urls/mentions and collapses whitespace', () => {
    const parsed = normalizeTweetRow(
      {
        tweet_id: '5',
        author_id: 'customer_b',
        text: '@AmazonHelp  my RETURN &amp; refund   https://t.co/abc is stuck ',
        created_at: '2020-10-05T08:00:00.000Z',
        in_response_to_tweet_id: '',
        response_tweet_id: '',
      },
      1,
    );

    assert.equal(parsed.text, 'my RETURN & refund is stuck');
  });

  it('treats the placeholder link values as "no link"', () => {
    for (const value of ['', 'NaN', 'null', '0', '  ']) assert.equal(cleanId(value), null);
    assert.equal(cleanId(' 12345 '), '12345');
  });

  it('splits a multi-id response list and discards placeholders', () => {
    const parsed = normalizeTweetRow(
      {
        tweet_id: '6',
        author_id: 'AmazonHelp',
        text: 'answering several',
        created_at: '2020-10-05T08:00:00.000Z',
        in_response_to_tweet_id: 'NaN',
        response_tweet_id: '111, NaN ,222',
      },
      1,
    );

    assert.deepEqual(parsed.responseIds, ['111', '222']);
    assert.equal(parsed.parentId, null);
  });

  it('streams rows and stops early when asked to', async () => {
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    const directory = await mkdtemp(path.join(tmpdir(), 'hiver-fixture-'));
    const csvPath = path.join(directory, 'mini.csv');
    await writeFile(
      csvPath,
      [
        'tweet_id,author_id,inbound,created_at,text,response_tweet_id,in_response_to_tweet_id',
        '1,customer_a,true,2020-10-05T08:00:00.000Z,"first",,',
        '2,AmazonHelp,false,2020-10-05T08:01:00.000Z,"second",1,1',
        '3,customer_a,true,2020-10-05T08:02:00.000Z,"third",,2',
      ].join('\n'),
      'utf8',
    );

    const seen = [];
    const first = await streamTweetRows(csvPath, (record) => {
      seen.push(record.tweet_id);
      return record.tweet_id !== '2';
    });

    assert.deepEqual(seen, ['1', '2']);
    assert.equal(first.stoppedEarly, true);
    assert.equal(first.rowsScanned, 2);
  });
});
