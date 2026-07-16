const express = require("express");
const router = express.Router();
const networkController = require("../controllers/networkController");
const authenticateToken = require("../middleware/auth");

router.get("/candidates", authenticateToken, networkController.getCandidates);

router.get("/matches", authenticateToken, networkController.getMatches);
router.post("/matches", authenticateToken, networkController.saveMatches);
router.delete("/matches/:id", authenticateToken, networkController.deleteMatch);

router.get("/lists", authenticateToken, networkController.getLists);
router.post("/lists", authenticateToken, networkController.addList);

module.exports = router;
