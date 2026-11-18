// Self-hosted Renovate configuration shared by the Docker image and a
// Renovate checkout run from source. scripts/run.ts sets the environment.
module.exports = {
  platform: 'gerrit',
  endpoint: process.env.GERRIT_URL,
  username: 'renovate',
  password: process.env.RENOVATE_GERRIT_PASSWORD,
  repositories: ['rejected-label-demo'],
  onboarding: false,
  requireConfig: 'optional',
  gitAuthor: 'Renovate <renovate@example.org>',
  // Reviewers are added only once the change fails its checks.
  automerge: true,
  assignAutomerge: false,
  reviewers: ['alice'],
  // The account voting Verified becomes a reviewer of the change; it must not
  // count as a human reviewer already assigned.
  ignoreReviewers: ['ci'],
};
