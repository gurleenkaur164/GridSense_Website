const jwt = require('jsonwebtoken');

// Returns the decoded user for a dashboard request, or null.
function userFromRequest(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

// The robot authenticates with a shared device key (ROBOT_API_KEY env var).
function isRobot(req) {
  const key = req.headers['x-api-key'];
  return Boolean(process.env.ROBOT_API_KEY) && key === process.env.ROBOT_API_KEY;
}

module.exports = { userFromRequest, isRobot };
