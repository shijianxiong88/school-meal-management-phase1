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

function assertWorkflowMutable(status) {
    if (status === '已完成') {
        throw new Error('已完成的遴选项目只能查看，不能继续流程管理');
    }
}

function validateCandidateSelection({ acceptedCount, selectedCount }) {
    if (acceptedCount < 1) {
        throw new Error('暂无审核通过企业，不能确认备选企业');
    }
    if (acceptedCount > 5 && selectedCount < 5) {
        throw new Error('审核通过企业大于5家时，备选企业不少于5家');
    }
    if (acceptedCount <= 5 && selectedCount !== acceptedCount) {
        throw new Error('审核通过企业不超过5家时，应全部确定为备选企业');
    }
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
    validateRegistrationReview,
    validateCandidateSelection,
    validateShortlistSelection,
    validateVotingMetadata,
    determineVotingWinner
};
