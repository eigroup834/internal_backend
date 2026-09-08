const express    = require('express');
const router     = express.Router();
const auth       = require('../middleware/auth');
const requireLevel = require('../middleware/requireLevel');
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
router.get('/batches',                          requireLevel(VIEW), ctrl.getBatches);
router.get('/batches/:batchId',                 requireLevel(VIEW), ctrl.getBatchDetail);
router.put('/batches/:batchId/status',          requireLevel(MANAGE), ctrl.updateBatchStatus);

router.get('/batches/:batchId/contacts',        requireLevel(VIEW), ctrl.getBatchContacts);
router.post('/batches/:batchId/assign',         requireLevel(MANAGE), ctrl.assignContacts);
router.post('/batches/:batchId/smart-assign',   requireLevel(MANAGE), ctrl.smartAssign);
router.post('/batches/:batchId/reassign',       requireLevel(MANAGE), ctrl.reassignContacts);

router.get('/external-leads',                    requireLevel(VIEW), extCtrl.list);
router.get('/external-leads/designations',       requireLevel(VIEW), extCtrl.designations);
router.post('/external-leads/assign',            requireLevel(MANAGE), extCtrl.assign);
router.patch('/external-leads/:id/reclassify',   requireLevel(LOG), extCtrl.reclassify);
router.post('/external-leads/:id/log',           requireLevel(LOG), extCtrl.addLeadLog);
router.get('/external-leads/:id/logs',           requireLevel(LOG), extCtrl.getLeadLogs);

router.get('/team-members',                 ctrl.getTeamMembers);

router.get('/my-contacts',                  ctrl.getMyContacts);
router.get('/my-stats',                     requireLevel(LOG), ctrl.getMyStats);
router.get('/telecmi-credentials',          requireLevel(LOG), ctrl.getTelecmiCredentials);

router.get('/followups',                    ctrl.getFollowups);

router.post('/contacts/:contactId/log',     requireLevel(LOG), ctrl.addContactLog);
router.get('/contacts/:contactId/logs',     ctrl.getContactLogs);

module.exports = router;
