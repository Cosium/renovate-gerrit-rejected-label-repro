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
const admin = { username: 'admin', password: 'secret' };
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
  gerritUrl: string,
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<T> => {
  const response = await fetch(`${gerritUrl}/a/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${admin.username}:${admin.password}`).toString('base64')}`,
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

const computeLogPrefix = (mode: Mode): string => {
  if (mode.kind === 'released') {
    return 'released';
  }
  return `source-${run('git', ['rev-parse', '--short', 'HEAD'], { cwd: mode.renovateClone }).trim()}`;
};

const runRenovate = (
  gerritUrl: string,
  mode: Mode,
  logPrefix: string,
  renovateRunNumber: number,
  renovatePassword: string,
  workDirectory: string,
): void => {
  const name = `${logPrefix}-run${renovateRunNumber}`;
  log(`Renovate run ${renovateRunNumber} (${logPrefix}), log: logs/${name}.log`);
  rmSync(join(reproDir, 'logs', `${name}.log`), { force: true });
  if (mode.kind === 'released') {
    run(
      'docker',
      [
        'compose',
        'run',
        '--rm',
        '-e',
        `RENOVATE_GERRIT_PASSWORD=${renovatePassword}`,
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
      RENOVATE_GERRIT_PASSWORD: renovatePassword,
      GERRIT_URL: `${gerritUrl}/`,
      LOG_LEVEL: 'debug',
      LOG_FORMAT: 'json',
      RENOVATE_BASE_DIR: join(workDirectory, `renovate-run${renovateRunNumber}`),
    }),
    stdio: [
      'ignore',
      openSync(join(reproDir, 'logs', `${name}.log`), 'w'),
      'inherit',
    ],
  });
};

const findRenovateChange = async (gerritUrl: string): Promise<Change> => {
  const changes = await callGerrit<readonly Change[]>(
    gerritUrl,
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

const readBranchStatusDecisions = (logName: string): readonly string[] => {
  const messages = readFileSync(join(reproDir, logName), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as LogEntry).msg)
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
  return messages;
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
  const gerritUrl = `http://${run('docker', ['compose', 'port', 'gerrit', '8080']).trim()}`;
  console.log(`Gerrit is on ${gerritUrl}`);
  return gerritUrl;
};

const prepareLogDirectory = (): void => {
  const logs = join(reproDir, 'logs');
  mkdirSync(logs, { recursive: true });
  // The Renovate container writes its logs as another user.
  chmodSync(logs, 0o777);
};

const createAccount = async (
  gerritUrl: string,
  username: string,
): Promise<string> => {
  const password = randomBytes(18).toString('base64');
  await callGerrit(gerritUrl, `accounts/${username}`, {
    method: 'PUT',
    body: {
      name: username,
      email: `${username}@example.org`,
      http_password: password,
    },
  });
  return password;
};

const createProject = async (
  gerritUrl: string,
  workDirectory: string,
): Promise<void> => {
  log(`Creating project ${project} with a Verified label and submit requirement`);
  await callGerrit(gerritUrl, `projects/${project}`, {
    method: 'PUT',
    body: { branches: ['master'], create_empty_commit: true },
  });
  // A label as Gerrit documents it since submit requirements replaced label
  // functions: NoBlock, its veto expressed by the submit requirement.
  await callGerrit(gerritUrl, `projects/${project}/labels/Verified`, {
    method: 'PUT',
    body: {
      function: 'NoBlock',
      values: { '-1': 'Fails', ' 0': 'No score', '+1': 'Verified' },
      commit_message: 'Add the Verified label',
    },
  });
  await callGerrit(gerritUrl, `projects/${project}/submit_requirements/Verified`, {
    method: 'PUT',
    body: {
      name: 'Verified',
      submittability_expression: 'label:Verified=MAX AND -label:Verified=MIN',
      allow_override_in_child_projects: false,
      commit_message: 'Add the Verified submit requirement',
    },
  });
  const administrators = await callGerrit<{ readonly id: string }>(
    gerritUrl,
    'groups/Administrators',
  );
  await callGerrit(gerritUrl, `projects/${project}/access`, {
    method: 'POST',
    body: {
      add: {
        'refs/heads/*': {
          permissions: {
            'label-Verified': {
              rules: {
                [administrators.id]: { action: 'ALLOW', min: -1, max: 1 },
              },
            },
            push: { rules: { [administrators.id]: { action: 'ALLOW' } } },
          },
        },
      },
    },
  });
  const seed = join(workDirectory, 'seed');
  run('git', [
    'clone',
    '--quiet',
    `${gerritUrl.replace('://', `://${admin.username}:${admin.password}@`)}/a/${project}`,
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
const logPrefix = computeLogPrefix(mode);
const workDirectory = mkdtempSync(join(tmpdir(), 'rejected-label-'));
const gerritUrl = startCleanGerrit();
try {
  prepareLogDirectory();
  log('Creating users renovate and alice (reviewer)');
  const renovatePassword = await createAccount(gerritUrl, 'renovate');
  await createAccount(gerritUrl, 'alice');
  await createProject(gerritUrl, workDirectory);

  runRenovate(gerritUrl, mode, logPrefix, 1, renovatePassword, workDirectory);
  log('Change after run 1 (automerge: no reviewer while the checks are pending)');
  const created = await findRenovateChange(gerritUrl);
  printChange(created);

  log('admin votes Verified -1 (the build of the change failed)');
  await callGerrit(
    gerritUrl,
    `changes/${created._number}/revisions/current/review`,
    { method: 'POST', body: { labels: { Verified: -1 } } },
  );
  const failed = await findRenovateChange(gerritUrl);
  const verified = failed.labels?.Verified ?? {};
  console.log(
    `  labels.Verified: rejected ${'rejected' in verified ? 'set' : 'absent'}, blocking ${'blocking' in verified ? 'set' : 'absent'}`,
  );
  console.log(`  submittable: ${failed.submittable ?? false}`);
  for (const requirement of failed.submit_requirements ?? []) {
    console.log(`  submit requirement ${requirement.name}: ${requirement.status}`);
  }

  runRenovate(gerritUrl, mode, logPrefix, 2, renovatePassword, workDirectory);
  const logName = `logs/${logPrefix}-run2.log`;
  log(`Branch status and reviewer decisions of run 2 (${logName})`);
  const decisions = readBranchStatusDecisions(logName);
  for (const decision of decisions) {
    console.log(`  ${decision}`);
  }
  log('Change after run 2');
  console.log(
    `  reviewers: ${JSON.stringify(listReviewers(await findRenovateChange(gerritUrl)))}`,
  );
  if (decisions.includes('Branch status red')) {
    log('Not reproduced: the failed change has a red branch status');
  } else if (decisions.includes('Branch status yellow')) {
    log('Reproduced: the failed change has a yellow branch status');
    process.exitCode = 1;
  } else {
    throw new Error(`Unexpected branch status in ${logName}`);
  }
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
