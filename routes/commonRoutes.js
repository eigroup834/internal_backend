const express = require('express');
const router = express.Router();
const commonController = require('../controllers/commonController');
const authenticateToken = require('../middleware/auth');

router.get('/countries', commonController.getCountries);
router.get('/states', commonController.getStates);
router.get('/cities', commonController.getCities);
router.get('/editor', authenticateToken, commonController.getEditors);
router.get('/categories', authenticateToken, commonController.getCategories);

router.get('/stats', authenticateToken, commonController.getStats);        
router.get('/activity', authenticateToken, commonController.getActivity);
router.post('/export', authenticateToken, commonController.exportData);

router.get('/events', authenticateToken, commonController.getEvents);
router.get('/eventAttendee', authenticateToken, commonController.getEventsAttendee);
router.put('/events/:id', authenticateToken, commonController.updateEventAttendee);

router.get('/eventsSearch', authenticateToken, commonController.getEventsWithSearch);
router.post('/addevent', authenticateToken, commonController.addEvent);
router.delete('/events/:id', authenticateToken, commonController.deleteEvent);

router.get('/tags', authenticateToken, commonController.getTags);
router.post('/addtags', authenticateToken, commonController.addTags);
router.put('/tags/:tagCode', authenticateToken, commonController.updateTag);

router.get('/groups', authenticateToken, commonController.getGroups);
router.post('/addGroup', authenticateToken, commonController.addGroup);
router.put('/groups/:groupCode', authenticateToken, commonController.updateGroup);
router.delete('/groups/:groupCode', authenticateToken, commonController.deleteGroup);

router.post('/addEditor', authenticateToken, commonController.addEditor);
router.post('/editEditor', authenticateToken, commonController.editEditor);

router.get('/dashboard/stats', authenticateToken, commonController.getDashboardStats);
router.get('/dashboard/activity', authenticateToken, commonController.getDashboardActivity);
router.get('/dashboard/myEntries', authenticateToken, commonController.getMyDailyEntries);
router.get('/reports/activityReport', authenticateToken, commonController.getActivityReport);
router.get('/reports/salesReport',    authenticateToken, commonController.getSalesReport);

module.exports = router;
