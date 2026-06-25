const express    = require('express');
const router     = express.Router();
const auth       = require('../middleware/auth');
const ctrl       = require('../controllers/visitorController');

router.use(auth);

router.get('/report-preview',               ctrl.getReportPreview);

router.get('/dashboard',                        ctrl.getDashboard);
router.get('/analytics',                        ctrl.getAnalytics);

router.post('/batches',                         ctrl.createBatch);
router.get('/batches',                          ctrl.getBatches);
router.get('/batches/:batchId',                 ctrl.getBatchDetail);
router.put('/batches/:batchId/status',          ctrl.updateBatchStatus);

router.get('/batches/:batchId/contacts',        ctrl.getBatchContacts);
router.post('/batches/:batchId/assign',         ctrl.assignContacts);
router.post('/batches/:batchId/smart-assign',   ctrl.smartAssign);
router.post('/batches/:batchId/reassign',       ctrl.reassignContacts);

router.get('/team-members',                 ctrl.getTeamMembers);

router.get('/my-contacts',                  ctrl.getMyContacts);

router.get('/followups',                    ctrl.getFollowups);

router.post('/contacts/:contactId/log',     ctrl.addContactLog);
router.get('/contacts/:contactId/logs',     ctrl.getContactLogs);

module.exports = router;
