const express = require("express");
const router = express.Router();
const smartSearchController = require("../controllers/smartSearchController");
const authenticateToken = require("../middleware/auth");

router.post("/persons", authenticateToken, smartSearchController.smartSearch);

module.exports = router;
