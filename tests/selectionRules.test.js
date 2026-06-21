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
  validateSelectionWorkgroup,
  validateSelectionPublishPrerequisites,
  validateCandidateEmergencySelection,
  validateEmergencySupplementEligibility,
  validateEmergencySupplementSelection,
  getLatestInspectionsByEnterprise,
  getPassedLatestInspections,
  validateInspectionRecord,
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

test('selection workgroup requires parent representatives to be at least eighty percent', () => {
  assert.doesNotThrow(() =>
    validateSelectionWorkgroup({ memberCount: 10, parentCount: 8 })
  );

  assert.throws(
    () => validateSelectionWorkgroup({ memberCount: 10, parentCount: 7 }),
    /不低于80%/
  );

  assert.throws(
    () => validateSelectionWorkgroup({ memberCount: 0, parentCount: 0 }),
    /成员总人数必须大于0/
  );

  assert.throws(
    () => validateSelectionWorkgroup({ memberCount: 10, parentCount: 11 }),
    /家长人数不能超过成员总人数/
  );
});

test('external catering selection requires workgroup registration before publish', () => {
  assert.throws(
    () => validateSelectionPublishPrerequisites({
      serviceType: '校外供餐',
      workgroupMemberCount: undefined,
      workgroupParentCount: undefined,
      workgroupRegisteredAt: ''
    }),
    /请先完成校外供餐遴选工作小组登记/
  );

  assert.doesNotThrow(() =>
    validateSelectionPublishPrerequisites({
      serviceType: '校外供餐',
      workgroupMemberCount: 10,
      workgroupParentCount: 8,
      workgroupRegisteredAt: '2026-06-19T00:00:00.000Z'
    })
  );

  assert.doesNotThrow(() =>
    validateSelectionPublishPrerequisites({ serviceType: '食材供应' })
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
    /全部确定为考察企业/
  );

  assert.doesNotThrow(() => validateCandidateSelection({ acceptedCount: 6, selectedCount: 5 }));
  assert.doesNotThrow(() => validateCandidateSelection({ acceptedCount: 5, selectedCount: 5 }));
});

test('candidate selection uses emergency backup enterprises only when no regular enterprises registered', () => {
  const acceptedRegistrations = [
    { enterpriseId: 'regular_1', enterpriseName: '普通企业' },
    { enterpriseId: 'emergency_1', enterpriseName: '应急企业' }
  ];
  const emergencyEnterpriseIds = new Set(['emergency_1']);

  assert.throws(
    () => validateCandidateEmergencySelection({
      serviceType: '校外供餐',
      acceptedRegistrations,
      selectedEnterpriseIds: ['regular_1', 'emergency_1'],
      emergencyEnterpriseIds
    }),
    /存在非应急备选企业报名时，不能选择应急备选企业/
  );

  assert.doesNotThrow(() =>
    validateCandidateEmergencySelection({
      serviceType: '校外供餐',
      acceptedRegistrations,
      selectedEnterpriseIds: ['regular_1'],
      emergencyEnterpriseIds
    })
  );

  assert.doesNotThrow(() =>
    validateCandidateEmergencySelection({
      serviceType: '校外供餐',
      acceptedRegistrations: [{ enterpriseId: 'emergency_1', enterpriseName: '应急企业' }],
      selectedEnterpriseIds: ['emergency_1'],
      emergencyEnterpriseIds
    })
  );

  assert.doesNotThrow(() =>
    validateCandidateEmergencySelection({
      serviceType: '食材供应',
      acceptedRegistrations,
      selectedEnterpriseIds: ['regular_1', 'emergency_1'],
      emergencyEnterpriseIds
    })
  );
});

test('inspection record requires a selected result', () => {
  assert.throws(
    () => validateInspectionRecord({ passed: null }),
    /\u8003\u5bdf\u7ed3\u679c\u4e3a\u5fc5\u586b\u9879/
  );

  assert.throws(
    () => validateInspectionRecord({ passed: '' }),
    /\u8003\u5bdf\u7ed3\u679c\u4e3a\u5fc5\u586b\u9879/
  );

  assert.doesNotThrow(() => validateInspectionRecord({ passed: true }));

  assert.throws(
    () => validateInspectionRecord({ passed: false, inspectionResult: '' }),
    /不通过原因/
  );

  assert.doesNotThrow(() => validateInspectionRecord({ passed: false, inspectionResult: '现场条件不符合要求' }));
});

test('emergency supplement requires fewer than three regular inspections all failed', () => {
  const emergencyEnterpriseIds = new Set(['emergency_1', 'emergency_2']);

  assert.doesNotThrow(() =>
    validateEmergencySupplementEligibility({
      serviceType: '校外供餐',
      inspections: [
        { enterpriseId: 'regular_1', passed: false },
        { enterpriseId: 'regular_2', passed: false },
        { enterpriseId: 'emergency_1', passed: true }
      ],
      emergencyEnterpriseIds
    })
  );

  assert.throws(
    () => validateEmergencySupplementEligibility({
      serviceType: '校外供餐',
      inspections: [
        { enterpriseId: 'regular_1', passed: false },
        { enterpriseId: 'regular_2', passed: false },
        { enterpriseId: 'regular_3', passed: false }
      ],
      emergencyEnterpriseIds
    }),
    /非应急考察企业已达到3家/
  );

  assert.throws(
    () => validateEmergencySupplementEligibility({
      serviceType: '校外供餐',
      inspections: [
        { enterpriseId: 'regular_1', passed: false },
        { enterpriseId: 'regular_2', passed: true }
      ],
      emergencyEnterpriseIds
    }),
    /非应急考察企业存在通过/
  );

  assert.throws(
    () => validateEmergencySupplementEligibility({
      serviceType: '校外供餐',
      regularCandidateEnterpriseIds: ['regular_1', 'regular_2', 'regular_3'],
      inspections: [
        { enterpriseId: 'regular_1', passed: false },
        { enterpriseId: 'regular_2', passed: false }
      ],
      emergencyEnterpriseIds
    }),
    /非应急考察企业已达到3家/
  );

  assert.throws(
    () => validateEmergencySupplementEligibility({
      serviceType: '校外供餐',
      regularCandidateEnterpriseIds: ['regular_1', 'regular_2'],
      inspections: [
        { enterpriseId: 'regular_1', passed: false }
      ],
      emergencyEnterpriseIds
    }),
    /请完成所有非应急考察企业/
  );

  assert.doesNotThrow(() =>
    validateEmergencySupplementEligibility({
      serviceType: '校外供餐',
      regularCandidateEnterpriseIds: ['regular_1', 'regular_2'],
      inspections: [
        { enterpriseId: 'regular_1', passed: true, updatedAt: '2026-06-21T08:00:00.000Z' },
        { enterpriseId: 'regular_1', passed: false, updatedAt: '2026-06-21T09:00:00.000Z' },
        { enterpriseId: 'regular_2', passed: false, updatedAt: '2026-06-21T09:30:00.000Z' },
        { enterpriseId: 'regular_2', passed: false, updatedAt: '2026-06-21T10:00:00.000Z' }
      ],
      emergencyEnterpriseIds
    })
  );
});

test('emergency supplement selection follows five-or-all rule', () => {
  assert.throws(
    () => validateEmergencySupplementSelection({ availableCount: 6, selectedCount: 4 }),
    /不少于5家/
  );

  assert.throws(
    () => validateEmergencySupplementSelection({ availableCount: 4, selectedCount: 3 }),
    /应全部确定为补充考察企业/
  );

  assert.doesNotThrow(() =>
    validateEmergencySupplementSelection({ availableCount: 4, selectedCount: 4 })
  );
  assert.doesNotThrow(() =>
    validateEmergencySupplementSelection({ availableCount: 6, selectedCount: 5 })
  );
});

test('latest inspection result per enterprise overrides older records', () => {
  const inspections = [
    {
      enterpriseId: 'enterprise_1',
      enterpriseName: 'A',
      passed: true,
      updatedAt: '2026-06-21T08:00:00.000Z'
    },
    {
      enterpriseId: 'enterprise_1',
      enterpriseName: 'A',
      passed: false,
      updatedAt: '2026-06-21T09:00:00.000Z'
    },
    {
      enterpriseId: 'enterprise_2',
      enterpriseName: 'B',
      passed: true,
      updatedAt: '2026-06-21T08:30:00.000Z'
    }
  ];

  const latest = getLatestInspectionsByEnterprise(inspections);
  assert.equal(latest.length, 2);
  assert.equal(latest.find(i => i.enterpriseId === 'enterprise_1').passed, false);
  assert.deepEqual(
    getPassedLatestInspections(inspections).map(i => i.enterpriseId),
    ['enterprise_2']
  );
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
