const express    = require('express');
const router     = express.Router();
const auth       = require('../middleware/auth');
const requireLevel = require('../middleware/requireLevel');
const uploadExcel = require('../middleware/uploadExcel');
const ctrl       = require('../controllers/visitorController');
const extCtrl    = require('../controllers/externalLeadController');

router.use(auth);

const CREATE    = [1, 2];
const VIEW      = [2, 5, 6];
const MANAGE    = [2, 5];
const LOG       = [2, 5, 6];
const ANALYTICS = [2, 5];

router.get('/report-preview',               ctrl.getReportPreview);

router.get('/dashboard',                        requireLevel(ANALYTICS), ctrl.getDashboard);
router.get('/analytics',                        requireLevel(ANALYTICS), ctrl.getAnalytics);

router.post('/batches',                         requireLevel(CREATE), ctrl.createBatch);
router.post('/batches/upload',                  requireLevel(CREATE), uploadExcel, ctrl.uploadBatch);
router.get('/batches/mine',                     requireLevel(CREATE), ctrl.getMyCreatedBatches);
router.get('/batches',                          requireLevel(VIEW), ctrl.getBatches);
router.get('/batches/:batchId',                 requireLevel(VIEW), ctrl.getBatchDetail);
router.put('/batches/:batchId/status',          requireLevel(MANAGE), ctrl.updateBatchStatus);

router.get('/batches/:batchId/contacts',        requireLevel(VIEW), ctrl.getBatchContacts);
router.post('/batches/:batchId/assign',         requireLevel(MANAGE), ctrl.assignContacts);
router.post('/batches/:batchId/smart-assign',   requireLevel(MANAGE), ctrl.smartAssign);
router.post('/batches/:batchId/reassign',       requireLevel(MANAGE), ctrl.reassignContacts);

const fintechCollection = (req, res, next) => { req.leadCollection = 'fintech'; next(); };
router.get('/fintech-delegates', requireLevel(VIEW), fintechCollection, extCtrl.list);
router.get('/fintech-delegates/designations', requireLevel(VIEW), fintechCollection, extCtrl.designations);
router.post('/fintech-delegates/assign', requireLevel(MANAGE), fintechCollection, extCtrl.assign);
router.patch('/fintech-delegates/:id/reclassify', requireLevel(LOG), fintechCollection, extCtrl.requireLeadAccess, extCtrl.reclassify);
router.post('/fintech-delegates/:id/log', requireLevel(LOG), fintechCollection, extCtrl.requireLeadAccess, extCtrl.addLeadLog);
router.get('/fintech-delegates/:id/logs', requireLevel(LOG), fintechCollection, extCtrl.requireLeadAccess, extCtrl.getLeadLogs);
router.patch('/fintech-delegates/:id/remark', requireLevel(LOG), fintechCollection, extCtrl.requireLeadAccess, extCtrl.editRemark);

router.post('/fintech-delegates/sync', requireLevel(MANAGE), async (req, res) => {
  try {
    const result = await require('../jobs/fintechDelegateSyncJob').runFintechDelegateSync();
    if (result.skipped) return res.status(503).json({ error: 'Fintech API key is not configured' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Fintech delegate sync failed:', err.message);
    res.status(502).json({ error: 'Unable to sync Fintech delegates. Check the source API and backend sync logs.' });
  }
});

router.get('/external-leads',                    requireLevel(VIEW), extCtrl.list);
router.get('/external-leads/designations',       requireLevel(VIEW), extCtrl.designations);
router.post('/external-leads/assign',            requireLevel(MANAGE), extCtrl.assign);
router.patch('/external-leads/:id/reclassify',   requireLevel(LOG), extCtrl.requireLeadAccess, extCtrl.reclassify);
router.post('/external-leads/:id/log',           requireLevel(LOG), extCtrl.requireLeadAccess, extCtrl.addLeadLog);
router.get('/external-leads/:id/logs',           requireLevel(LOG), extCtrl.requireLeadAccess, extCtrl.getLeadLogs);
router.patch('/external-leads/:id/remark',       requireLevel(LOG), extCtrl.requireLeadAccess, extCtrl.editRemark);

router.get('/team-members',                 ctrl.getTeamMembers);

router.get('/my-contacts',                  ctrl.getMyContacts);
router.get('/my-stats',                     requireLevel(LOG), ctrl.getMyStats);
router.get('/telecmi-credentials',          requireLevel(LOG), ctrl.getTelecmiCredentials);

router.get('/followups',                    ctrl.getFollowups);

router.post('/contacts/:contactId/log',     requireLevel(LOG), ctrl.addContactLog);
router.get('/contacts/:contactId/logs',     ctrl.getContactLogs);
router.patch('/contacts/:contactId/reclassify', requireLevel(LOG), ctrl.reclassifyContact);
router.get('/contacts/:contactId/cross-batch-history', requireLevel(LOG), ctrl.getContactCrossBatchHistory);

module.exports = router;
