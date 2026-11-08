const express = require('express');
const router = express.Router();

const game = require("@controllers/game.controller");
const authController = require('@controllers/auth.controller');

router.post('/player/gameplay/checkversion', game.checkVersion);
router.post('/player/getban', game.getBan);
router.post('/player/playerstat/get', authController.verifySession, game.getPlayerStats);

module.exports = router;
