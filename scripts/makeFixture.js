import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { heading, parseArgs, print, printPairs, resolvePath, runScript } from './lib/cli.js';

/** Column order of the real Kaggle file. */
const HEADER = 'tweet_id,author_id,inbound,created_at,text,response_tweet_id,in_response_to_tweet_id';

/**
 * Customer message + brand reply per intent, plus a second turn for some threads.
 * Kept short and comma-free except where quoted.
 *
 * @type {ReadonlyArray<{ intent: string, customer: string, agent: string, followUp?: string }>}
 */
const INTENT_SCRIPTS = Object.freeze([
  {
    intent: 'ORDER_STATUS',
    customer: 'Where is my order? It should have arrived on Tuesday and the tracking has not moved.',
    agent: 'Sorry about the wait. Send us the order number and we will check the tracking with the carrier.',
    followUp: 'It is 112-3344556 and it still says in transit.',
  },
  {
    intent: 'RETURN_REFUND',
    customer: 'I want a refund for order 223-9911. I already sent the item back last week.',
    agent: 'Thanks for returning it. Send the order number and we will confirm the refund on your card.',
    followUp: 'The order number is 223-9911.',
  },
  {
    intent: 'ACCOUNT_ACCESS',
    customer: 'I cannot log in to my account and the password reset email never arrives.',
    agent: 'Let us get you back in. Check the spam folder for the reset email and we will resend it if needed.',
  },
  {
    intent: 'PRODUCT_COMPLAINT',
    customer: 'The blender arrived damaged with a cracked lid. I need a replacement.',
    agent: 'Sorry the blender arrived damaged. Send a photo of the item and we will arrange a replacement.',
    followUp: 'Photo sent. It was cracked along the seam.',
  },
  {
    intent: 'DELIVERY_ISSUE',
    customer: 'Tracking says delivered but I never received the package at my address.',
    agent: 'Thanks for flagging this. Send the order number and we will open an investigation with the courier.',
    followUp: 'Order 112-9988776. Nobody knocked and there is no photo.',
  },
  {
    intent: 'BILLING_DISPUTE',
    customer: 'You charged me twice for the same order this month. I want the duplicate charge refunded.',
    agent: 'Sorry about the duplicate charge. Send the order number and we will refund the extra payment.',
    followUp: 'Order 445566. The two charges were 42 dollars each.',
  },
  {
    intent: 'GENERAL_INQUIRY',
    customer: 'Do you deliver to PO boxes and is gift wrapping available for Prime members?',
    agent: 'Yes to both. PO box delivery is standard and gift wrapping can be selected at checkout.',
  },
  {
    intent: 'ABUSE_SPAM',
    customer: 'Buy followers cheap and check out my store for crypto trading signals. Dm me!',
    agent: 'We have reviewed this account and cannot help with that request.',
  },
]);

/**
 * Build the fixture rows.
 *
 * Includes deliberate hazards the loader must survive:
 *   - a thread with a dangling `in_response_to_tweet_id` (parent never appears),
 *   - a brand-only component (must be dropped: no customer message),
 *   - a 50-message merged component (must be dropped as an over-merged artifact),
 *   - unrelated non-Amazon traffic that must be ignored entirely.
 *
 * @param {number} perIntent - Threads to emit per intent.
 * @returns {string[]} CSV lines including the header.
 */
function buildFixtureRows(perIntent) {
  const lines = [HEADER];
  let tweetId = 1000;
  let clock = Date.parse('2020-10-05T08:00:00.000Z');

  /** @returns {string} Next tweet id. */
  const nextId = () => String((tweetId += 7));
  /** @returns {string} Next timestamp, one minute apart. */
  const nextTime = () => new Date((clock += 60_000)).toISOString();

  for (const script of INTENT_SCRIPTS) {
    for (let index = 0; index < perIntent; index += 1) {
      const customerId = nextId();
      const agentId = nextId();
      const suffix = index === 0 ? '' : ` (case ${index + 1})`;

      lines.push(row(customerId, `customer_${script.intent.toLowerCase()}_${index}`, true, nextTime(), `${script.customer}${suffix}`, '', ''));
      lines.push(row(agentId, BRAND_HANDLES[index % BRAND_HANDLES.length], false, nextTime(), script.agent, customerId, customerId));

      if (script.followUp && index % 2 === 0) {
        const followUpId = nextId();
        const secondReplyId = nextId();
        lines.push(row(followUpId, `customer_${script.intent.toLowerCase()}_${index}`, true, nextTime(), `${script.followUp}${suffix}`, '', agentId));
        lines.push(row(secondReplyId, 'AmazonHelp', false, nextTime(), 'Thanks — we have picked this up and will follow up here shortly.', followUpId, followUpId));
      }
    }
  }

  // Hazard 1: dangling parent id — must still produce a usable single-turn thread.
  const orphanCustomer = nextId();
  const orphanAgent = nextId();
  lines.push(row(orphanCustomer, 'customer_orphan', true, nextTime(), 'My parcel was left at the wrong address and I cannot find it.', '', '999999999'));
  lines.push(row(orphanAgent, 'AmazonHelp', false, nextTime(), 'Sorry about that. Send the order number and we will trace the delivery.', orphanCustomer, orphanCustomer));

  // Hazard 2: brand-only component (no customer message) — must be dropped.
  const loneBrand = nextId();
  lines.push(row(loneBrand, 'AmazonHelp', false, nextTime(), 'This thread has no customer message attached to it.', '', ''));

  // Hazard 3: over-merged component (>40 messages) — must be dropped.
  let previous = nextId();
  lines.push(row(previous, 'customer_merged', true, nextTime(), 'Thread that the dataset wrongly merged with many replies.', '', ''));
  for (let index = 0; index < 50; index += 1) {
    const id = nextId();
    const brand = index % 2 === 0;
    lines.push(
      row(
        id,
        brand ? 'AmazonHelp' : 'customer_merged',
        !brand,
        nextTime(),
        brand ? `Automated acknowledgement number ${index}.` : `Follow-up message number ${index} about the merged thread.`,
        brand ? previous : '',
        previous,
      ),
    );
    previous = id;
  }

  // Hazard 4: unrelated traffic that is not part of an Amazon conversation.
  for (let index = 0; index < 5; index += 1) {
    const id = nextId();
    lines.push(row(id, `random_user_${index}`, true, nextTime(), `Unrelated chatter number ${index} that mentions no brand at all.`, '', ''));
  }

  return lines;
}

/** @type {ReadonlyArray<string>} Brand handles, mirroring the real dataset's variety. */
const BRAND_HANDLES = Object.freeze(['AmazonHelp', 'Amazon', 'AmazonCS', 'AmazonHelp']);

/**
 * Serialise one CSV row, quoting the text field.
 *
 * @param {string} tweetId - Tweet id.
 * @param {string} authorId - Author id.
 * @param {boolean} inbound - Whether the tweet came from a customer.
 * @param {string} createdAt - ISO timestamp.
 * @param {string} text - Tweet text.
 * @param {string} responseTweetId - Ids this tweet replied to.
 * @param {string} inResponseToTweetId - Id this tweet responds to.
 * @returns {string} CSV line.
 */
function row(tweetId, authorId, inbound, createdAt, text, responseTweetId, inResponseToTweetId) {
  const quoted = `"${text.replace(/"/g, '""')}"`;
  return [tweetId, authorId, String(inbound), createdAt, quoted, responseTweetId, inResponseToTweetId].join(',');
}

/**
 * `npm run fixture` — write a small `twcs.csv`-shaped file so the whole data
 * layer (frontier scan → union-find reconstruction → inserts → text index →
 * retrieval) can be verified without the 500 MB Kaggle download.
 *
 * THIS IS NOT REAL DATA. It exists to prove the pipeline works end to end; every
 * number produced from it must be labelled as fixture-derived, never reported as
 * a result. Real evaluation needs the actual dataset (`npm run seed`).
 *
 * Usage:
 *   npm run fixture
 *   npm run fixture -- --threads=48 --out=data/raw/twcs.fixture.csv
 */
await runScript('fixture', async () => {
  const args = parseArgs();
  const outPath = resolvePath(args.out, path.resolve(process.cwd(), 'data/raw/twcs.fixture.csv'));
  const requested = args.threads ? Number(args.threads) : 24;
  const perIntent = Math.max(1, Math.round(requested / INTENT_SCRIPTS.length));

  const rows = buildFixtureRows(perIntent);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${rows.join('\n')}\n`, 'utf8');

  heading('Fixture written (NOT real data)');
  printPairs({
    output: outPath,
    dataRows: rows.length - 1,
    threads: INTENT_SCRIPTS.length * perIntent + 2,
    perIntent,
  });
  print('');
  print('Verify the data layer with:');
  print(`  npm run seed -- --csv=${path.relative(process.cwd(), outPath)} --limit=100`);
});
