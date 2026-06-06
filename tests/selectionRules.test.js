const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nextSelectionStatus,
  previousSelectionStatus,
  validateRegistrationReview,
  validateCandidateSelection,
  validateShortlistSelection,
  determineVotingWinner,
  validateVotingMetadata,
  validateAnnouncementPublish,
  assertWorkflowMutable
} = require('../server/selectionRules');

test('registration rejection requires a reason', () => {
  assert.throws(
    () => validateRegistrationReview({ status: '审核不通过', reviewComments: '' }),
    /拒绝原因/
  );

  assert.doesNotThrow(() =>
    validateRegistrationReview({ status: '审核不通过', reviewComments: '资质材料不完整' })
  );
});

test('announcement publish requires content, publish URL, and registration deadline only', () => {
  assert.throws(
    () => validateAnnouncementPublish({ content: '公告内容', publishUrl: '', registrationDeadline: '2026-06-30' }),
    /发布公告网址/
  );

  assert.doesNotThrow(() =>
    validateAnnouncementPublish({
      content: '公告内容',
      requirements: '',
      publishUrl: 'https://example.com/notice',
      registrationDeadline: '2026-06-30'
    })
  );
});

test('completed selection workflow is view-only', () => {
  assert.throws(() => assertWorkflowMutable('已完成'), /已完成的遴选项目只能查看/);
  assert.doesNotThrow(() => assertWorkflowMutable('待签合同'));
});

test('candidate selection follows offline random count rules', () => {
  assert.throws(
    () => validateCandidateSelection({ acceptedCount: 6, selectedCount: 4 }),
    /不少于5家/
  );

  assert.throws(
    () => validateCandidateSelection({ acceptedCount: 5, selectedCount: 4 }),
    /全部确定为备选/
  );

  assert.doesNotThrow(() => validateCandidateSelection({ acceptedCount: 6, selectedCount: 5 }));
  assert.doesNotThrow(() => validateCandidateSelection({ acceptedCount: 5, selectedCount: 5 }));
});

test('shortlist requires at least three inspected and passed enterprises', () => {
  assert.throws(
    () => validateShortlistSelection({ passedCount: 4, selectedCount: 2 }),
    /至少3家/
  );

  assert.doesNotThrow(() => validateShortlistSelection({ passedCount: 4, selectedCount: 3 }));
});

test('voting winner requires absolute majority of valid votes', () => {
  assert.deepEqual(
    determineVotingWinner([
      { enterpriseId: 'a', enterpriseName: 'A', votes: 3 },
      { enterpriseId: 'b', enterpriseName: 'B', votes: 6 },
      { enterpriseId: 'c', enterpriseName: 'C', votes: 1 }
    ]),
    { enterpriseId: 'b', enterpriseName: 'B', votes: 6, totalVotes: 10, voteRatio: 0.6 }
  );

  let revoteError;
  try {
    determineVotingWinner([
      { enterpriseId: 'a', enterpriseName: 'A', votes: 4 },
      { enterpriseId: 'b', enterpriseName: 'B', votes: 3 },
      { enterpriseId: 'c', enterpriseName: 'C', votes: 3 }
    ]);
  } catch (err) {
    revoteError = err;
  }

  assert.ok(revoteError);
  assert.match(revoteError.message, /没有企业有效得票超过50%/);
  assert.deepEqual(revoteError.revoteEnterprises, [
    { enterpriseId: 'a', enterpriseName: 'A', votes: 4 },
    { enterpriseId: 'b', enterpriseName: 'B', votes: 3 }
  ]);
});

test('valid vote count must equal the sum of enterprise votes', () => {
  assert.throws(
    () => validateVotingMetadata({
      voteTime: '2026-06-05',
      voteLocation: '学校会议室',
      parentAttendance: 6,
      voteResults: [
        { enterpriseId: 'a', votes: 3 },
        { enterpriseId: 'b', votes: 2 },
        { enterpriseId: 'c', votes: 1 }
      ],
      validVotes: 5
    }),
    /有效票数必须等于各企业得票数总和/
  );

  assert.doesNotThrow(() =>
    validateVotingMetadata({
      voteTime: '2026-06-05',
      voteLocation: '学校会议室',
      parentAttendance: 6,
      voteResults: [
        { enterpriseId: 'a', votes: 3 },
        { enterpriseId: 'b', votes: 2 },
        { enterpriseId: 'c', votes: 1 }
      ],
      validVotes: 6
    })
  );
});

test('selection status moves forward and can return one step', () => {
  assert.equal(nextSelectionStatus('项目已立项'), '报名审核中');
  assert.equal(nextSelectionStatus('家长投票中'), '待签合同');
  assert.equal(previousSelectionStatus('报名审核中'), '项目已立项');
  assert.equal(previousSelectionStatus('考察中'), '备选确认中');
  assert.equal(previousSelectionStatus('已完成'), null);
});
