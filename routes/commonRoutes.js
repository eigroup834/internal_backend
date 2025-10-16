const express = require('express');
const router = express.Router();
const commonController = require('../controllers/commonController');

router.get('/countries', commonController.getCountries);
router.get('/states', commonController.getStates);
router.get('/cities', commonController.getCities);
router.get('/editor', commonController.getEditors);
router.get('/categories', commonController.getCategories);

router.get('/stats', commonController.getStats);        
router.get('/activity', commonController.getActivity);

router.get('/tags', commonController.getTags);

module.exports = router;
