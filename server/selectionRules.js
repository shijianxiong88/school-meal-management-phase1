const SELECTION_STATUSES = [
    '项目已立项',
    '报名审核中',
    '备选确认中',
    '考察中',
    '入围确认中',
    '家长投票中',
    '待签合同',
    '已完成'
];

function nextSelectionStatus(status) {
    const idx = SELECTION_STATUSES.indexOf(status);
    if (idx === -1 || idx >= SELECTION_STATUSES.length - 1) return null;
    return SELECTION_STATUSES[idx + 1];
}

function previousSelectionStatus(status) {
    const idx = SELECTION_STATUSES.indexOf(status);
    if (idx <= 0 || status === '已完成') return null;
    return SELECTION_STATUSES[idx - 1];
}

function validateRegistrationReview({ status, reviewComments }) {
    if (!['审核通过', '审核不通过', '已受理', '已拒绝'].includes(status)) {
        throw new Error('无效的审核状态');
    }
    if ((status === '审核不通过' || status === '已拒绝') && !String(reviewComments || '').trim()) {
        throw new Error('审核不通过时必须填写拒绝原因');
    }
}

function validateAnnouncementPublish({ content, publishUrl, registrationDeadline }) {
    if (!String(content || '').trim()) {
        throw new Error('请填写公告内容');
    }
    if (!String(publishUrl || '').trim()) {
        throw new Error('请填写发布公告网址');
    }
    if (!String(registrationDeadline || '').trim()) {
        throw new Error('请填写报名截止日期');
    }
}

function validateSelectionWorkgroup({ memberCount, parentCount }) {
    const normalizedMemberCount = Number(memberCount);
    const normalizedParentCount = Number(parentCount);

    if (!Number.isInteger(normalizedMemberCount) || normalizedMemberCount <= 0) {
        throw new Error('成员总人数必须大于0');
    }
    if (!Number.isInteger(normalizedParentCount) || normalizedParentCount < 0) {
        throw new Error('家长人数不能小于0');
    }
    if (normalizedParentCount > normalizedMemberCount) {
        throw new Error('家长人数不能超过成员总人数');
    }
    if (normalizedParentCount / normalizedMemberCount < 0.8) {
        throw new Error('家长人数占比不低于80%');
    }

    return {
        memberCount: normalizedMemberCount,
        parentCount: normalizedParentCount,
        parentRatio: normalizedParentCount / normalizedMemberCount
    };
}

function validateSelectionPublishPrerequisites(announcement) {
    if (announcement?.serviceType !== '校外供餐') return;

    if (!announcement.workgroupRegisteredAt) {
        throw new Error('请先完成校外供餐遴选工作小组登记');
    }

    validateSelectionWorkgroup({
        memberCount: announcement.workgroupMemberCount,
        parentCount: announcement.workgroupParentCount
    });
}

function assertWorkflowMutable(status) {
    if (status === '已完成') {
        throw new Error('已完成的遴选项目只能查看，不能继续流程管理');
    }
}

function validateCandidateSelection({ acceptedCount, selectedCount }) {
    if (acceptedCount < 1) {
        throw new Error('暂无审核通过企业，不能确认考察企业');
    }
    if (acceptedCount > 5 && selectedCount < 5) {
        throw new Error('审核通过企业大于5家时，考察企业不少于5家');
    }
    if (acceptedCount <= 5 && selectedCount !== acceptedCount) {
        throw new Error('审核通过企业不超过5家时，应全部确定为考察企业');
    }
}

function validateCandidateEmergencySelection({ serviceType, acceptedRegistrations, selectedEnterpriseIds, emergencyEnterpriseIds }) {
    if (serviceType !== '校外供餐') return;

    const emergencyIds = emergencyEnterpriseIds || new Set();
    const accepted = acceptedRegistrations || [];
    const hasRegularRegistration = accepted.some(reg => !emergencyIds.has(reg.enterpriseId));
    if (!hasRegularRegistration) return;

    const selectedIds = selectedEnterpriseIds || [];
    const selectedEmergency = accepted.find(reg =>
        selectedIds.includes(reg.enterpriseId) && emergencyIds.has(reg.enterpriseId)
    );
    if (selectedEmergency) {
        throw new Error('存在非应急备选企业报名时，不能选择应急备选企业确定考察企业名单');
    }
}

function validateInspectionRecord({ passed, inspectionResult }) {
    if (passed !== true && passed !== false) {
        throw new Error('\u8003\u5bdf\u7ed3\u679c\u4e3a\u5fc5\u586b\u9879');
    }
    if (passed === false && !String(inspectionResult || '').trim()) {
        throw new Error('考察不通过原因必填');
    }
}

function validateEmergencySupplementEligibility({ serviceType, inspections, emergencyEnterpriseIds, regularCandidateEnterpriseIds }) {
    if (serviceType !== '校外供餐') {
        throw new Error('仅校外供餐项目可启用应急备选补充考察');
    }

    const emergencyIds = emergencyEnterpriseIds || new Set();
    const regularCandidateIds = regularCandidateEnterpriseIds || [];
    if (regularCandidateIds.length >= 3) {
        throw new Error('非应急考察企业已达到3家，不能启用应急备选补充考察');
    }

    const regularInspections = getLatestInspectionsByEnterprise(
        (inspections || []).filter(inspection =>
            regularCandidateIds.length
                ? regularCandidateIds.includes(inspection.enterpriseId)
                : !emergencyIds.has(inspection.enterpriseId)
        )
    );

    if (!regularInspections.length) {
        throw new Error('请先完成非应急企业考察后再启用应急备选补充考察');
    }
    if (regularCandidateIds.length && regularInspections.length < regularCandidateIds.length) {
        throw new Error('请完成所有非应急考察企业记录后再启用应急备选补充考察');
    }
    if (regularInspections.length >= 3) {
        throw new Error('非应急考察企业已达到3家，不能启用应急备选补充考察');
    }
    if (regularInspections.some(inspection => inspection.passed !== false)) {
        throw new Error('非应急考察企业存在通过或未确认结果，不能启用应急备选补充考察');
    }
}

function validateEmergencySupplementSelection({ availableCount, selectedCount }) {
    const normalizedAvailableCount = Number(availableCount || 0);
    const normalizedSelectedCount = Number(selectedCount || 0);

    if (normalizedAvailableCount < 1) {
        throw new Error('暂无符合条件的应急备选报名供应商');
    }
    if (normalizedAvailableCount >= 5 && normalizedSelectedCount < 5) {
        throw new Error('符合条件的应急备选报名供应商不少于5家时，补充考察企业不少于5家');
    }
    if (normalizedAvailableCount < 5 && normalizedSelectedCount !== normalizedAvailableCount) {
        throw new Error('符合条件的应急备选报名供应商少于5家时，应全部确定为补充考察企业');
    }
}

function inspectionTimestamp(inspection) {
    return new Date(inspection?.updatedAt || inspection?.createdAt || 0).getTime();
}

function getLatestInspectionsByEnterprise(inspections) {
    const latestByEnterprise = new Map();
    (inspections || []).forEach(inspection => {
        if (!inspection?.enterpriseId) return;
        const current = latestByEnterprise.get(inspection.enterpriseId);
        if (!current || inspectionTimestamp(inspection) >= inspectionTimestamp(current)) {
            latestByEnterprise.set(inspection.enterpriseId, inspection);
        }
    });
    return Array.from(latestByEnterprise.values());
}

function getPassedLatestInspections(inspections) {
    return getLatestInspectionsByEnterprise(inspections)
        .filter(inspection => inspection.passed === true);
}

function validateShortlistSelection({ passedCount, selectedCount }) {
    if (passedCount < 3) {
        throw new Error('考察通过企业不足3家，不能确认入围企业');
    }
    if (selectedCount < 3) {
        throw new Error('入围企业至少3家');
    }
}

function voteTotal(voteRows) {
    return (voteRows || []).reduce((sum, row) => sum + Number(row.votes || 0), 0);
}

function validateVotingMetadata({ voteResults, validVotes, voteTime, voteLocation, parentAttendance }) {
    if (!String(voteTime || '').trim()) {
        throw new Error('请填写投票时间');
    }
    if (!String(voteLocation || '').trim()) {
        throw new Error('请填写投票地点');
    }
    if (Number(parentAttendance || 0) <= 0) {
        throw new Error('请填写家长到位人数');
    }
    const totalVotes = voteTotal(voteResults);
    if (Number(validVotes) !== totalVotes) {
        throw new Error('有效票数必须等于各企业得票数总和');
    }
}

function determineVotingWinner(voteRows) {
    const rows = (voteRows || []).map(row => ({
        ...row,
        votes: Number(row.votes || 0)
    }));
    if (!rows.length) {
        throw new Error('请录入投票结果');
    }
    const totalVotes = voteTotal(rows);
    if (totalVotes <= 0) {
        throw new Error('有效投票数必须大于0');
    }

    const sortedRows = [...rows].sort((a, b) => b.votes - a.votes);
    const winner = sortedRows.find(row => row.votes / totalVotes > 0.5);
    if (winner) {
        return {
            enterpriseId: winner.enterpriseId,
            enterpriseName: winner.enterpriseName,
            votes: winner.votes,
            totalVotes,
            voteRatio: winner.votes / totalVotes
        };
    }

    const revoteEnterprises = sortedRows.slice(0, 2).map(row => ({
        enterpriseId: row.enterpriseId,
        enterpriseName: row.enterpriseName,
        votes: row.votes
    }));
    const err = new Error('没有企业有效得票超过50%，请组织得票最高的2家企业重新投票');
    err.revoteEnterprises = revoteEnterprises;
    throw err;
}

module.exports = {
    SELECTION_STATUSES,
    nextSelectionStatus,
    previousSelectionStatus,
    assertWorkflowMutable,
    validateAnnouncementPublish,
    validateSelectionWorkgroup,
    validateSelectionPublishPrerequisites,
    validateRegistrationReview,
    validateCandidateSelection,
    validateCandidateEmergencySelection,
    validateInspectionRecord,
    validateEmergencySupplementEligibility,
    validateEmergencySupplementSelection,
    getLatestInspectionsByEnterprise,
    getPassedLatestInspections,
    validateShortlistSelection,
    validateVotingMetadata,
    determineVotingWinner
};
