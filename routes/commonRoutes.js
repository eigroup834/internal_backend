const express = require('express');
const router = express.Router();
const commonController = require('../controllers/commonController');
const authenticateToken = require('../middleware/auth');

router.get('/countries', commonController.getCountries);
router.get('/states', commonController.getStates);
router.get('/cities', commonController.getCities);
router.get('/editor', commonController.getEditors);
router.get('/categories', commonController.getCategories);

router.get('/stats', commonController.getStats);        
router.get('/activity', commonController.getActivity);

router.get('/tags', commonController.getTags);
router.post('/addtags', authenticateToken, commonController.addTags);
router.put('/tags/:tagCode', authenticateToken, commonController.updateTag);


module.exports = router;
