function sortByCreatedAtDesc(items) {
    return [...(items || [])].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function canViewAnnouncement(announcement, user) {
    if (!announcement || !user) return false;
    if (user.role === 'admin') return true;
    if (user.role === 'school') {
        return announcement.schoolId === (user.schoolId || user.id);
    }
    return false;
}

function buildSelectionWorkflowDetail(records, announcementId, user) {
    const announcement = (records.announcements || []).find(a => a.id === announcementId);
    if (!announcement) {
        const err = new Error('selection announcement not found');
        err.statusCode = 404;
        throw err;
    }

    if (!canViewAnnouncement(announcement, user)) {
        const err = new Error('permission denied');
        err.statusCode = 403;
        throw err;
    }

    const byAnnouncement = item => item.announcementId === announcementId;

    return {
        announcement,
        registrations: sortByCreatedAtDesc((records.registrations || []).filter(byAnnouncement)),
        candidates: sortByCreatedAtDesc((records.candidates || []).filter(byAnnouncement)),
        inspections: sortByCreatedAtDesc((records.inspections || []).filter(byAnnouncement)),
        shortlisted: sortByCreatedAtDesc((records.shortlisted || []).filter(byAnnouncement)),
        results: sortByCreatedAtDesc((records.results || []).filter(byAnnouncement)),
        contracts: sortByCreatedAtDesc((records.contracts || []).filter(byAnnouncement))
    };
}

module.exports = {
    buildSelectionWorkflowDetail
};
