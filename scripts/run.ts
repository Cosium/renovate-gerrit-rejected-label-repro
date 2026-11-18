// Reproduces Renovate reading a Gerrit change with Verified -1 as a pending
// branch status, from a clean Gerrit.
//
// Usage:
//   node scripts/run.ts released                 # renovate/renovate Docker image
//   node scripts/run.ts source <renovate-clone>  # Renovate run from source (pnpm start)
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type Mode =
  | { readonly kind: 'released' }
  | { readonly kind: 'source'; readonly renovateClone: string };

interface Account {
  readonly username: string;
  readonly password: string;
}

interface LogEntry {
  readonly msg: string;
}

interface Change {
  readonly _number: number;
  readonly subject: string;
  readonly submittable?: boolean;
  readonly labels?: Record<string, object>;
  readonly reviewers?: {
    readonly REVIEWER?: readonly { readonly username: string }[];
  };
  readonly submit_requirements?: readonly {
    readonly name: string;
    readonly status: string;
  }[];
}

const reproDir = dirname(import.meta.dirname);
const admin: Account = { username: 'admin', password: 'secret' };
const project = 'rejected-label-demo';

const parseMode = (args: readonly string[]): Mode => {
  const [kind, renovateClone] = args;
  if (kind === 'released') {
    return { kind };
  }
  if (kind === 'source' && renovateClone) {
    return { kind, renovateClone: resolve(renovateClone) };
  }
  console.error('usage: node scripts/run.ts released | source <renovate-clone>');
  process.exit(2);
};

const log = (message: string): void => {
  console.log(`\n==> ${message}`);
};

// The caller's own RENOVATE_* variables would otherwise change the runs.
const buildEnvironment = (
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('RENOVATE_'),
    ),
  ),
  ...overrides,
});

const run = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): string =>
  execFileSync(command, args, {
    cwd: options.cwd ?? reproDir,
    env: buildEnvironment(options.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const callGerrit = async <T>(
  path: string,
  init: {
    readonly method?: string;
    readonly body?: unknown;
    readonly account?: Account;
  } = {},
): Promise<T> => {
  const account = init.account ?? admin;
  const response = await fetch(`${gerrit}/a/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${account.username}:${account.password}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text}`);
  }
  // Gerrit prefixes JSON responses with )]}' to prevent XSSI.
  return JSON.parse(text.slice(text.indexOf('\n') + 1)) as T;
};

const computeLabel = (mode: Mode): string => {
  if (mode.kind === 'released') {
    return 'released';
  }
  const commit = run('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: mode.renovateClone,
  }).trim();
  return `source-${commit}`;
};

const runRenovate = (
  mode: Mode,
  label: string,
  renovateRun: number,
  renovate: Account,
  work: string,
): void => {
  const name = `${label}-run${renovateRun}`;
  log(`Renovate run ${renovateRun} (${label}), log: logs/${name}.log`);
  rmSync(join(reproDir, 'logs', `${name}.log`), { force: true });
  if (mode.kind === 'released') {
    run(
      'docker',
      [
        'compose',
        'run',
        '--rm',
        '--no-deps',
        '-e',
        `RENOVATE_GERRIT_PASSWORD=${renovate.password}`,
        'renovate',
      ],
      { env: { LOG_NAME: name } },
    );
    return;
  }
  // Renovate lower-cases LOG_FILE, which breaks paths with capitals, so its
  // JSON output is written to the log instead.
  execFileSync('pnpm', ['--silent', 'start'], {
    cwd: mode.renovateClone,
    env: buildEnvironment({
      RENOVATE_CONFIG_FILE: join(reproDir, 'config.js'),
      RENOVATE_GERRIT_PASSWORD: renovate.password,
      GERRIT_URL: `${gerrit}/`,
      LOG_LEVEL: 'debug',
      LOG_FORMAT: 'json',
      RENOVATE_BASE_DIR: join(work, `renovate-run${renovateRun}`),
    }),
    stdio: [
      'ignore',
      openSync(join(reproDir, 'logs', `${name}.log`), 'w'),
      'inherit',
    ],
  });
};

const findRenovateChange = async (): Promise<Change> => {
  const changes = await callGerrit<readonly Change[]>(
    `changes/?q=owner:renovate+status:open+project:${project}&o=LABELS&o=DETAILED_LABELS&o=DETAILED_ACCOUNTS&o=SUBMITTABLE&o=SUBMIT_REQUIREMENTS`,
  );
  const [change] = changes;
  if (changes.length !== 1 || !change) {
    throw new Error(`Expected one open change of renovate, found ${changes.length}`);
  }
  return change;
};

const listReviewers = (change: Change): readonly string[] =>
  (change.reviewers?.REVIEWER ?? []).map((reviewer) => reviewer.username);

const printChange = (change: Change): void => {
  console.log(`  change ${change._number}: ${change.subject}`);
  console.log(`  reviewers: ${JSON.stringify(listReviewers(change))}`);
};

const parseLogEntry = (line: string): LogEntry | undefined => {
  try {
    return JSON.parse(line) as LogEntry;
  } catch {
    return undefined;
  }
};

const printBranchStatusDecisions = (label: string): void => {
  const logName = `logs/${label}-run2.log`;
  log(`Branch status and reviewer decisions of run 2 (${logName})`);
  const messages = readFileSync(join(reproDir, logName), 'utf8')
    .split('\n')
    .map(parseLogEntry)
    .filter((entry) => entry !== undefined)
    .map((entry) => entry.msg)
    .filter((message) =>
      /^(Branch status |Setting assignees and reviewers|PR is not ready for merge)/.test(
        message,
      ),
    );
  if (messages.length === 0) {
    throw new Error(
      `No branch status in ${logName}: Renovate stopped early, see that log`,
    );
  }
  for (const message of messages) {
    console.log(`  ${message}`);
  }
};

// Gerrit listens on a port Docker picks, so another service on 8080 is no obstacle.
const startCleanGerrit = (): string => {
  log('Starting a clean Gerrit');
  try {
    run('docker', ['compose', 'down', '-v', '--remove-orphans']);
  } catch (error) {
    console.trace('Stopping a previous Gerrit failed', error);
  }
  run('docker', ['compose', 'up', '-d', '--wait', 'gerrit']);
  const address = run('docker', ['compose', 'port', 'gerrit', '8080']).trim();
  const url = `http://${address}`;
  console.log(`Gerrit is on ${url}`);
  return url;
};

const prepareLogDirectory = (): void => {
  const logs = join(reproDir, 'logs');
  mkdirSync(logs, { recursive: true });
  // The Renovate container writes its logs as another user.
  chmodSync(logs, 0o777);
};

const createAccount = async (username: string): Promise<Account> => {
  const password = randomBytes(18).toString('base64');
  await callGerrit(`accounts/${username}`, {
    method: 'PUT',
    body: {
      name: username,
      email: `${username}@example.org`,
      http_password: password,
    },
  });
  return { username, password };
};

const createProject = async (work: string): Promise<void> => {
  log(`Creating project ${project} with a Verified label and submit requirement`);
  await callGerrit(`projects/${project}`, {
    method: 'PUT',
    body: { branches: ['master'], create_empty_commit: true },
  });
  // A label as Gerrit documents it since submit requirements replaced label
  // functions: NoBlock, its veto expressed by the submit requirement.
  await callGerrit(`projects/${project}/labels/Verified`, {
    method: 'PUT',
    body: {
      function: 'NoBlock',
      values: { '-1': 'Fails', ' 0': 'No score', '+1': 'Verified' },
      commit_message: 'Add the Verified label',
    },
  });
  await callGerrit(`projects/${project}/submit_requirements/Verified`, {
    method: 'PUT',
    body: {
      name: 'Verified',
      submittability_expression: 'label:Verified=MAX AND -label:Verified=MIN',
      allow_override_in_child_projects: false,
      commit_message: 'Add the Verified submit requirement',
    },
  });
  const ciGroup = await callGerrit<{ readonly id: string }>('groups/CI', {
    method: 'PUT',
    body: { members: ['ci'] },
  });
  const administrators = await callGerrit<{ readonly id: string }>(
    'groups/Administrators',
  );
  await callGerrit(`projects/${project}/access`, {
    method: 'POST',
    body: {
      add: {
        'refs/heads/*': {
          permissions: {
            'label-Verified': {
              rules: { [ciGroup.id]: { action: 'ALLOW', min: -1, max: 1 } },
            },
            push: { rules: { [administrators.id]: { action: 'ALLOW' } } },
          },
        },
      },
    },
  });
  const seed = join(work, 'seed');
  run('git', [
    'clone',
    '--quiet',
    `${gerrit.replace('://', '://admin:secret@')}/a/${project}`,
    seed,
  ]);
  cpSync(join(reproDir, 'project'), seed, { recursive: true });
  run('git', ['add', '-A'], { cwd: seed });
  run(
    'git',
    [
      '-c',
      'user.name=Administrator',
      '-c',
      'user.email=admin@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Add the demo project',
    ],
    { cwd: seed },
  );
  run('git', ['push', '--quiet', 'origin', 'HEAD:refs/heads/master'], {
    cwd: seed,
  });
};

const mode = parseMode(process.argv.slice(2));
const label = computeLabel(mode);
const work = mkdtempSync(join(tmpdir(), 'rejected-label-'));
const gerrit = startCleanGerrit();
try {
  prepareLogDirectory();
  log('Creating users renovate, alice (reviewer) and ci (votes Verified)');
  const renovate = await createAccount('renovate');
  await createAccount('alice');
  const ci = await createAccount('ci');
  await createProject(work);

  runRenovate(mode, label, 1, renovate, work);
  log('Change after run 1 (automerge: no reviewer while the checks are pending)');
  const created = await findRenovateChange();
  printChange(created);

  log('ci votes Verified -1 (the build of the change failed)');
  await callGerrit(`changes/${created._number}/revisions/current/review`, {
    method: 'POST',
    body: { labels: { Verified: -1 } },
    account: ci,
  });
  const failed = await findRenovateChange();
  const verified = failed.labels?.Verified ?? {};
  console.log(
    `  labels.Verified: rejected ${'rejected' in verified ? 'set' : 'absent'}, blocking ${'blocking' in verified ? 'set' : 'absent'}`,
  );
  console.log(`  submittable: ${failed.submittable ?? false}`);
  for (const requirement of failed.submit_requirements ?? []) {
    console.log(`  submit requirement ${requirement.name}: ${requirement.status}`);
  }

  runRenovate(mode, label, 2, renovate, work);
  printBranchStatusDecisions(label);
  log('Change after run 2');
  const reviewers = listReviewers(await findRenovateChange());
  console.log(`  reviewers: ${JSON.stringify(reviewers)}`);
  if (reviewers.includes('alice')) {
    log('Not reproduced: Renovate added alice to the failed change');
  } else {
    log('Reproduced: Renovate did not add alice to the failed change');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
