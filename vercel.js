// Shared source, separate deployments. Only the admin project schedules maintenance.
export const config = {
  regions:['dub1'],
  functions:{'api/index.js':{maxDuration:60,includeFiles:'{public,src}/**'}},
  routes:[{src:'/(.*)',dest:'/api/index.js'}],
  ...(process.env.SURFACE==='admin'&&process.env.DATABASE_URL&&process.env.CRON_SECRET?{crons:[{path:'/api/cron/maintenance',schedule:'0 3 * * *'}]}:{})
};
