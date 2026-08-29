const logger = require('../libs/logger');
const WebMonitorMod = require('../model/WebMonitorMod');

const webMonitorMod = new WebMonitorMod();

const respond = function (res, action, data = false) {
  try {
    const result = action();
    res.send(data ? { success: true, data: result } : { success: true, message: result });
  } catch (error) {
    logger.error(error);
    res.send({ success: false, message: error.message });
  }
};

class WebMonitor {
  async add (req, res) {
    respond(res, () => webMonitorMod.add(req.body));
  }

  async modify (req, res) {
    respond(res, () => webMonitorMod.modify(req.body));
  }

  async delete (req, res) {
    respond(res, () => webMonitorMod.delete(req.body));
  }

  async list (req, res) {
    respond(res, () => webMonitorMod.list(), true);
  }
}

module.exports = WebMonitor;
