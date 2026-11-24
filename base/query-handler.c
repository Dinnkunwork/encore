#include "include/config.h"
#include "include/nagios.h"
#include "include/downtime.h"
#include "include/comments.h"
#include "lib/libnagios.h"
#include "lib/nsock.h"
#include <unistd.h>
#include <stdlib.h>
#include <fcntl.h>
#include <poll.h>
#include <stdarg.h>

/* A registered handler */
struct query_handler {
	const char *name; /* also "address" of this handler. Must be unique */
	const char *description; /* short description of this handler */
	unsigned int options;
	qh_handler handler;
	struct query_handler *prev_qh, *next_qh;
};

static struct query_handler *qhandlers;
static int qh_listen_sock = -1; /* the listening socket */
static unsigned int qh_running;
unsigned int qh_max_running = 0; /* defaults to unlimited */
static dkhash_table *qh_table;

/* the echo service. stupid, but useful for testing */
static int qh_echo(int sd, char *buf, unsigned int len)
{
	int result = 0;

	if (buf == NULL || !strcmp(buf, "help")) {

		nsock_printf_nul(sd,
			"Query handler that simply echoes back what you send it.");
		return 0;
	}

	result = write(sd, buf, len);
	if (result == -1) {

		logit(NSLOG_RUNTIME_ERROR, TRUE, "qh: qh_echo() error on write(sd,buf=[%s],len=%d): %s\n", buf, len, strerror(errno));
	}
	return 0;
}

static struct query_handler *qh_find_handler(const char *name)
{
	return (struct query_handler *)dkhash_get(qh_table, name, NULL);
}

/* subset of http error codes */
const char *qh_strerror(int code)
{
	if (code < 0) {
		return "Low-level system error";
	}

	if (code == 100) {
		return "Continue";
	}
	if (code == 101) {
		return "Switching protocols";
	}

	if (code < 300) {
		return "OK";
	}

	if (code < 400) {
		return "Redirected (possibly deprecated address)";
	}

	switch (code) {

	/* client errors */
	case 400: return "Bad request";
	case 401: return "Unauthorized";
	case 403: return "Forbidden (disabled by config)";
	case 404: return "Not found";
	case 405: return "Method not allowed";
	case 406: return "Not acceptable";
	case 407: return "Proxy authentication required";
	case 408: return "Request timed out";
	case 409: return "Conflict";
	case 410: return "Gone";
	case 411: return "Length required";
	case 412: return "Precondition failed";
	case 413: return "Request too large";
	case 414: return "Request-URI too long";

	/* server errors */
	case 500: return "Internal server error";
	case 501: return "Not implemented";
	case 502: return "Bad gateway";
	case 503: return "Service unavailable";
	case 504: return "Gateway timeout";
	case 505: return "Version not supported";

	}

	return "Unknown error";
}

static int qh_input(int sd, int events, void *ioc_)
{
	iocache * ioc = (iocache *) ioc_;
	int result    = 0;

	/* 
		input on main socket, so accept one 
		this is when a worker initially connects
		we create the iocache and then register
		that to a new socket descriptor and this function
		so that ioc_ != NULL next time
	*/
	if (sd == qh_listen_sock) {

		struct sockaddr sa;
		socklen_t slen = 0;
		int nsd        = 0;

		/* shut valgrind up */
		memset(&sa, 0, sizeof(sa));
		nsd = accept(sd, &sa, &slen);
		if (qh_max_running && qh_running >= qh_max_running) {
			nsock_printf(nsd, "503: Server full");
			close(nsd);
			return 0;
		}

		ioc = iocache_create(16384);
		if (ioc == NULL) {
			logit(NSLOG_RUNTIME_ERROR, TRUE, "qh: Failed to create iocache for inbound request\n");
			nsock_printf(nsd, "500: Internal server error");
			close(nsd);
			return 0;
		}

		/*
		 * @todo: Stash the iocache and the socket in some
		 * addressable list so we can release them on deinit
		 */
		result = iobroker_register(nagios_iobs, nsd, ioc, qh_input);
		if (result < 0) {
			logit(NSLOG_RUNTIME_ERROR, TRUE, "qh: Failed to register input socket %d with I/O broker: %s\n", nsd, strerror(errno));
			iocache_destroy(ioc);
			close(nsd);
			return 0;
		}

		/* make it non-blocking, but leave kernel buffers unchanged */
		worker_set_sockopts(nsd, 0);
		qh_running++;
		return 0;
	}

	/*
		this is when an existing connection
		sends more data after they've already made
		the connection
	*/
	else {

		unsigned long len         = 0;
		unsigned int query_len    = 0;
		struct query_handler * qh = NULL;
		char * buf                = NULL;
		char * space              = NULL;
		char * handler            = NULL;
		char * query              = NULL;

		result = iocache_read(ioc, sd);

		/* disconnect? */
		if (result == 0 || (result < 0 && errno == EPIPE)) {
			iocache_destroy(ioc);
			iobroker_close(nagios_iobs, sd);
			qh_running--;
			return 0;
		}

		/*
		 * A request looks like this: '[@|#]<qh>[<SP>][<query>]\0'.
		 * That is, optional '#' (oneshot) or '@' (keepalive),
		 * followed by the name of a registered handler, followed by
		 * an optional space and an optional query. If the handler
		 * has no "default" handler, a query is required or an error
		 * will be thrown.
		 */

		/* Use data up to the first nul byte */
		buf = iocache_use_delim(ioc, "\0", 1, &len);
		if (buf == NULL) {
			return 0;
		}

		/* Identify handler part and any magic query bytes */
		if (*buf == '@' || *buf == '#') {
			handler = buf + 1;
		}

		/* Locate query (if any) */
		space = strchr(buf, ' ');
		if (space != NULL) {
			*space = 0;
			query = space + 1;
			query_len = len - (unsigned long)(query - buf);
		}

		/* locate the handler */
		qh = qh_find_handler(handler);

		/* not found. that's a 404 */
		if (qh == NULL) {
			nsock_printf(sd, "404: %s: No such handler", handler);
			iobroker_close(nagios_iobs, sd);
			iocache_destroy(ioc);
			return 0;
		}

		/* strip trailing newlines */
		while (query_len > 0
		       && (query[query_len - 1] == 0 || query[query_len - 1] == '\n')) {

			query[--query_len] = 0;	
		}

		/* now pass the query to the handler */
		result = qh->handler(sd, query, query_len);
		if (result >= 100) {
			nsock_printf_nul(sd, "%d: %s", result, qh_strerror(result));
		}

		/* error code or one-shot query */
		if (result >= 300 || *buf == '#') {
			iobroker_close(nagios_iobs, sd);
			iocache_destroy(ioc);
			return 0;
		}

		/* check for magic handler codes */
		switch (result) {

		/* oneshot handler */
		case QH_CLOSE:

		/* general error */
		case -1:
			iobroker_close(nagios_iobs, sd);

		/* fallthrough */

		/* handler takes over */
		case QH_TAKEOVER:

		/* switch protocol (takeover + message) */
		case 101:
			iocache_destroy(ioc);
			break;
		}
	}

	return 0;
}

int qh_deregister_handler(const char *name)
{
	struct query_handler *qh   = NULL;
	struct query_handler *next = NULL;
	struct query_handler *prev = NULL;

	qh = dkhash_remove(qh_table, name, NULL);
	if (qh == NULL) {
		return 0;
	}

	next = qh->next_qh;
	prev = qh->prev_qh;

	if (next != NULL) {
		next->prev_qh = prev;
	}

	if (prev != NULL) {
		prev->next_qh = next;
	}

	if (qh == qhandlers) {
		qhandlers = next;
	}

	free(qh);

	return 0;
}

int qh_register_handler(const char *name, const char *description, unsigned int options, qh_handler handler)
{
	struct query_handler *qh = NULL;
	int result = 0;

	if (name == NULL) {
		logit(NSLOG_RUNTIME_ERROR, TRUE, "qh: Failed to register handler with no name\n");
		return -1;
	}

	if (handler == NULL) {
		logit(NSLOG_RUNTIME_ERROR, TRUE, "qh: Failed to register handler '%s': No handler function specified\n", name);
		return -1;
	}

	if (strlen(name) > 128) {
		logit(NSLOG_RUNTIME_ERROR, TRUE, "qh: Failed to register handler '%s': Name too long\n", name);
		return -ENAMETOOLONG;
	}

	/* names must be unique */
	if (qh_find_handler(name)) {
		logit(NSLOG_RUNTIME_WARNING, TRUE, "qh: Handler '%s' registered more than once\n", name);
		return -1;
	}

	qh = calloc(1, sizeof(*qh));
	if (qh == NULL) {
		logit(NSLOG_RUNTIME_ERROR, TRUE, "qh: Failed to allocate memory for handler '%s'\n", name);
		return -errno;
	}

	qh->name               = name;
	qh->description        = description;
	qh->handler            = handler;
	qh->options            = options;
	qh->next_qh            = qhandlers;

	if (qhandlers) {
		qhandlers->prev_qh = qh;
	}

	qhandlers              = qh;

	result = dkhash_insert(qh_table, qh->name, NULL, qh);
	if (result < 0) {
		logit(NSLOG_RUNTIME_ERROR, TRUE,
			  "qh: Failed to insert query handler '%s' (%p) into hash table %p (%d): %s\n",
			  name, qh, qh_table, result, strerror(errno));
		free(qh);
		return result;
	}

	return 0;
}

void qh_deinit(const char *path)
{
	while (qhandlers) {
		qh_deregister_handler(qhandlers->name);
	}

	dkhash_destroy(qh_table);
	qh_table = NULL;
	qhandlers = NULL;

	if (path == NULL) {
		return;
	}

	unlink(path);
}

static int qh_help(int sd, char *buf, unsigned int len)
{
	struct query_handler *qh = NULL;

	if (buf == NULL || !strcmp(buf, "help")) {
		nsock_printf_nul(sd,
			"  help <name>   show help for handler <name>\n"
			"  help list     list registered handlers\n");
		return 0;
	}

	if (!strcmp(buf, "list")) {

		for (qh = qhandlers; qh != NULL; qh = qh->next_qh) {
			nsock_printf(sd, "%-10s %s\n", qh->name, qh->description ? qh->description : "(No description available)");
		}

		nsock_printf(sd, "%c", 0);
		return 0;
	}

	qh = qh_find_handler(buf);
	if (qh == NULL) {

		nsock_printf_nul(sd, "No handler named '%s' is registered\n", buf);

	} else if (qh->handler(sd, "help", 4) > 200) {

		nsock_printf_nul(sd, "The handler %s doesn't have any help yet.", buf);
	}

	return 0;
}

static int qh_core(int sd, char *buf, unsigned int len)
{
	char *space;

	if (buf == NULL || !strcmp(buf, "help")) {

		nsock_printf_nul(sd, 
			"Query handler for manipulating nagios core.\n"
			"Available commands:\n"
			"  loadctl           Print information about current load control settings\n"
			"  loadctl <options> Configure nagios load control.\n"
			"                    The options are the same parameters and format as\n"
			"                    returned above.\n"
			"  squeuestats       scheduling queue statistics\n"
		);

		return 0;
	}
	space = memchr(buf, ' ', len);

	if (space != NULL) {
		*(space++) = 0;
	}

	if (space == NULL) {

		if (!strcmp(buf, "loadctl")) {

			nsock_printf_nul(sd, 
				"jobs_max=%u;jobs_min=%u;"
				"jobs_running=%u;jobs_limit=%u;"
				"load=%.2f;"
				"backoff_limit=%.2f;backoff_change=%u;"
				"rampup_limit=%.2f;rampup_change=%u;"
				"nproc_limit=%u;nofile_limit=%u;"
				"options=%u;changes=%u;",
				loadctl.jobs_max, loadctl.jobs_min,
				loadctl.jobs_running, loadctl.jobs_limit,
				loadctl.load[0],
				loadctl.backoff_limit, loadctl.backoff_change,
				loadctl.rampup_limit, loadctl.rampup_change,
				loadctl.nproc_limit, loadctl.nofile_limit,
				loadctl.options, loadctl.changes
			);

			return 0;
		}

		else if (!strcmp(buf, "squeuestats")) {

			return dump_event_stats(sd);
		}
	}

	/* space != NULL: */
	else {

		len -= (unsigned long)(space - buf);

		if (!strcmp(buf, "loadctl")) {
			return set_loadctl_options(space, len) == OK ? 200 : 400;
		}
	}

	/* No matching command found */
	return 404;
}

/* Growable buffer and reliable writer for in-memory JSON state snapshots */
struct qh_sbuf {
	char *data;
	size_t len;
	size_t cap;
};

static int qh_sbuf_reserve(struct qh_sbuf *sb, size_t extra)
{
	size_t need = sb->len + extra + 1;
	size_t new_cap;
	char *p;

	if (need <= sb->cap)
		return 0;

	new_cap = sb->cap ? sb->cap * 2 : 65536;
	while (new_cap < need)
		new_cap *= 2;

	p = realloc(sb->data, new_cap);
	if (!p)
		return -1;

	sb->data = p;
	sb->cap = new_cap;
	return 0;
}

static int qh_sbuf_append(struct qh_sbuf *sb, const char *s, size_t n)
{
	if (qh_sbuf_reserve(sb, n) < 0)
		return -1;
	memcpy(sb->data + sb->len, s, n);
	sb->len += n;
	sb->data[sb->len] = '\0';
	return 0;
}

static int qh_sbuf_printf(struct qh_sbuf *sb, const char *fmt, ...)
{
	va_list ap, ap2;
	int needed;

	va_start(ap, fmt);
	va_copy(ap2, ap);
	needed = vsnprintf(NULL, 0, fmt, ap);
	va_end(ap);

	if (needed < 0 || qh_sbuf_reserve(sb, (size_t)needed) < 0) {
		va_end(ap2);
		return -1;
	}

	vsnprintf(sb->data + sb->len, (size_t)needed + 1, fmt, ap2);
	va_end(ap2);
	sb->len += (size_t)needed;
	return 0;
}

static int qh_sbuf_json_str(struct qh_sbuf *sb, const char *s)
{
	const unsigned char *p = (const unsigned char *)(s ? s : "");
	char esc[8];

	if (qh_sbuf_append(sb, "\"", 1) < 0)
		return -1;

	while (*p) {
		unsigned char c = *p++;
		if (c == '"' || c == '\\') {
			esc[0] = '\\';
			esc[1] = (char)c;
			if (qh_sbuf_append(sb, esc, 2) < 0)
				return -1;
		} else if (c == '\b') {
			if (qh_sbuf_append(sb, "\\b", 2) < 0)
				return -1;
		} else if (c == '\f') {
			if (qh_sbuf_append(sb, "\\f", 2) < 0)
				return -1;
		} else if (c == '\n') {
			if (qh_sbuf_append(sb, "\\n", 2) < 0)
				return -1;
		} else if (c == '\r') {
			if (qh_sbuf_append(sb, "\\r", 2) < 0)
				return -1;
		} else if (c == '\t') {
			if (qh_sbuf_append(sb, "\\t", 2) < 0)
				return -1;
		} else if (c < 0x20) {
			int n = snprintf(esc, sizeof(esc), "\\u%04x", c);
			if (qh_sbuf_append(sb, esc, (size_t)n) < 0)
				return -1;
		} else {
			if (qh_sbuf_append(sb, (const char *)&c, 1) < 0)
				return -1;
		}
	}

	return qh_sbuf_append(sb, "\"", 1);
}

static int qh_write_all(int sd, const char *data, size_t len)
{
	size_t off = 0;

	while (off < len) {
		ssize_t n = write(sd, data + off, len - off);
		if (n > 0) {
			off += (size_t)n;
			continue;
		}
		if (n < 0 && errno == EINTR)
			continue;
		if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
			struct pollfd pfd;
			pfd.fd = sd;
			pfd.events = POLLOUT;
			pfd.revents = 0;
			if (poll(&pfd, 1, 200) <= 0)
				return -1;
			continue;
		}
		return -1;
	}
	return 0;
}

static int qh_state(int sd, char *buf, unsigned int len)
{
	struct qh_sbuf sb = { NULL, 0, 0 };
	host *h;
	service *s;
	int first = 1;

	if (buf == NULL || !*buf || !strcmp(buf, "help")) {
		nsock_printf_nul(sd,
			"Query handler for fast in-memory JSON state snapshots.\n"
			"Available commands:\n"
			"  summary        Host/service state counts and program info\n"
			"  hosts          JSON array of all host states\n"
			"  services       JSON array of all service states\n"
			"  hostgroups     JSON array of all hostgroups and members\n"
			"  servicegroups  JSON array of all servicegroups and members\n"
			"  downtimes      JSON array of scheduled downtimes\n"
			"  comments       JSON array of host/service comments\n");
		return 0;
	}

	if (!strcmp(buf, "summary")) {
		unsigned int h_total = 0, h_up = 0, h_down = 0, h_unreach = 0, h_pending = 0;
		unsigned int s_total = 0, s_ok = 0, s_warn = 0, s_crit = 0, s_unk = 0, s_pending = 0;

		for (h = host_list; h != NULL; h = h->next) {
			h_total++;
			if (!h->has_been_checked) h_pending++;
			else if (h->current_state == STATE_UP) h_up++;
			else if (h->current_state == STATE_DOWN) h_down++;
			else h_unreach++;
		}
		for (s = service_list; s != NULL; s = s->next) {
			s_total++;
			if (!s->has_been_checked) s_pending++;
			else if (s->current_state == STATE_OK) s_ok++;
			else if (s->current_state == STATE_WARNING) s_warn++;
			else if (s->current_state == STATE_CRITICAL) s_crit++;
			else s_unk++;
		}

		if (qh_sbuf_printf(&sb,
			"{\"program\":{\"pid\":%d,\"program_start\":%llu,"
			"\"notifications_enabled\":%d,\"execute_service_checks\":%d,"
			"\"execute_host_checks\":%d,\"flap_detection_enabled\":%d,"
			"\"event_handlers_enabled\":%d},"
			"\"hosts\":{\"total\":%u,\"up\":%u,\"down\":%u,\"unreachable\":%u,\"pending\":%u},"
			"\"services\":{\"total\":%u,\"ok\":%u,\"warning\":%u,\"critical\":%u,\"unknown\":%u,\"pending\":%u}}",
			(int)getpid(), (unsigned long long)program_start,
			enable_notifications, execute_service_checks,
			execute_host_checks, enable_flap_detection,
			enable_event_handlers,
			h_total, h_up, h_down, h_unreach, h_pending,
			s_total, s_ok, s_warn, s_crit, s_unk, s_pending) < 0) {
			free(sb.data);
			return 500;
		}
	} else if (!strcmp(buf, "hosts")) {
		if (qh_sbuf_append(&sb, "[", 1) < 0) {
			free(sb.data);
			return 500;
		}
		for (h = host_list; h != NULL; h = h->next) {
			if (!first && qh_sbuf_append(&sb, ",", 1) < 0) { free(sb.data); return 500; }
			first = 0;
			if (qh_sbuf_append(&sb, "{\"name\":", 8) < 0 ||
				qh_sbuf_json_str(&sb, h->name) < 0 ||
				qh_sbuf_append(&sb, ",\"address\":", 11) < 0 ||
				qh_sbuf_json_str(&sb, h->address) < 0 ||
				qh_sbuf_printf(&sb,
					",\"current_state\":%d,\"state_type\":%d,\"has_been_checked\":%d,"
					"\"current_attempt\":%d,\"max_attempts\":%d,"
					"\"last_check\":%llu,\"next_check\":%llu,\"last_state_change\":%llu,"
					"\"acknowledged\":%d,\"downtime_depth\":%d,\"is_flapping\":%d,"
					"\"latency\":%.4f,\"execution_time\":%.4f,\"plugin_output\":",
					h->current_state, h->state_type, h->has_been_checked,
					h->current_attempt, h->max_attempts,
					(unsigned long long)h->last_check,
					(unsigned long long)h->next_check,
					(unsigned long long)h->last_state_change,
					h->problem_has_been_acknowledged,
					h->scheduled_downtime_depth,
					h->is_flapping,
					h->latency, h->execution_time) < 0 ||
				qh_sbuf_json_str(&sb, h->plugin_output) < 0 ||
				qh_sbuf_append(&sb, ",\"perf_data\":", 13) < 0 ||
				qh_sbuf_json_str(&sb, h->perf_data) < 0 ||
				qh_sbuf_append(&sb, "}", 1) < 0) {
				free(sb.data);
				return 500;
			}
		}
		if (qh_sbuf_append(&sb, "]", 1) < 0) {
			free(sb.data);
			return 500;
		}
	} else if (!strcmp(buf, "services")) {
		if (qh_sbuf_append(&sb, "[", 1) < 0) {
			free(sb.data);
			return 500;
		}
		for (s = service_list; s != NULL; s = s->next) {
			if (!first && qh_sbuf_append(&sb, ",", 1) < 0) { free(sb.data); return 500; }
			first = 0;
			if (qh_sbuf_append(&sb, "{\"host_name\":", 13) < 0 ||
				qh_sbuf_json_str(&sb, s->host_name) < 0 ||
				qh_sbuf_append(&sb, ",\"description\":", 15) < 0 ||
				qh_sbuf_json_str(&sb, s->description) < 0 ||
				qh_sbuf_printf(&sb,
					",\"current_state\":%d,\"state_type\":%d,\"has_been_checked\":%d,"
					"\"current_attempt\":%d,\"max_attempts\":%d,"
					"\"last_check\":%llu,\"next_check\":%llu,\"last_state_change\":%llu,"
					"\"acknowledged\":%d,\"downtime_depth\":%d,\"is_flapping\":%d,"
					"\"latency\":%.4f,\"execution_time\":%.4f,\"plugin_output\":",
					s->current_state, s->state_type, s->has_been_checked,
					s->current_attempt, s->max_attempts,
					(unsigned long long)s->last_check,
					(unsigned long long)s->next_check,
					(unsigned long long)s->last_state_change,
					s->problem_has_been_acknowledged,
					s->scheduled_downtime_depth,
					s->is_flapping,
					s->latency, s->execution_time) < 0 ||
				qh_sbuf_json_str(&sb, s->plugin_output) < 0 ||
				qh_sbuf_append(&sb, ",\"perf_data\":", 13) < 0 ||
				qh_sbuf_json_str(&sb, s->perf_data) < 0 ||
				qh_sbuf_append(&sb, "}", 1) < 0) {
				free(sb.data);
				return 500;
			}
		}
		if (qh_sbuf_append(&sb, "]", 1) < 0) {
			free(sb.data);
			return 500;
		}
	} else if (!strcmp(buf, "hostgroups")) {
		hostgroup *hg;
		if (qh_sbuf_append(&sb, "[", 1) < 0) { free(sb.data); return 500; }
		for (hg = hostgroup_list; hg != NULL; hg = hg->next) {
			hostsmember *hm;
			int mfirst = 1;
			if (!first && qh_sbuf_append(&sb, ",", 1) < 0) { free(sb.data); return 500; }
			first = 0;
			if (qh_sbuf_append(&sb, "{\"group_name\":", 14) < 0 ||
				qh_sbuf_json_str(&sb, hg->group_name) < 0 ||
				qh_sbuf_append(&sb, ",\"alias\":", 9) < 0 ||
				qh_sbuf_json_str(&sb, hg->alias) < 0 ||
				qh_sbuf_append(&sb, ",\"members\":[", 12) < 0) {
				free(sb.data);
				return 500;
			}
			for (hm = hg->members; hm != NULL; hm = hm->next) {
				if (!mfirst && qh_sbuf_append(&sb, ",", 1) < 0) { free(sb.data); return 500; }
				mfirst = 0;
				if (qh_sbuf_json_str(&sb, hm->host_name) < 0) { free(sb.data); return 500; }
			}
			if (qh_sbuf_append(&sb, "]}", 2) < 0) { free(sb.data); return 500; }
		}
		if (qh_sbuf_append(&sb, "]", 1) < 0) { free(sb.data); return 500; }
	} else if (!strcmp(buf, "servicegroups")) {
		servicegroup *sg;
		if (qh_sbuf_append(&sb, "[", 1) < 0) { free(sb.data); return 500; }
		for (sg = servicegroup_list; sg != NULL; sg = sg->next) {
			servicesmember *sm;
			int mfirst = 1;
			if (!first && qh_sbuf_append(&sb, ",", 1) < 0) { free(sb.data); return 500; }
			first = 0;
			if (qh_sbuf_append(&sb, "{\"group_name\":", 14) < 0 ||
				qh_sbuf_json_str(&sb, sg->group_name) < 0 ||
				qh_sbuf_append(&sb, ",\"alias\":", 9) < 0 ||
				qh_sbuf_json_str(&sb, sg->alias) < 0 ||
				qh_sbuf_append(&sb, ",\"members\":[", 12) < 0) {
				free(sb.data);
				return 500;
			}
			for (sm = sg->members; sm != NULL; sm = sm->next) {
				if (!mfirst && qh_sbuf_append(&sb, ",", 1) < 0) { free(sb.data); return 500; }
				mfirst = 0;
				if (qh_sbuf_append(&sb, "{\"host_name\":", 13) < 0 ||
					qh_sbuf_json_str(&sb, sm->host_name) < 0 ||
					qh_sbuf_append(&sb, ",\"description\":", 15) < 0 ||
					qh_sbuf_json_str(&sb, sm->service_description) < 0 ||
					qh_sbuf_append(&sb, "}", 1) < 0) {
					free(sb.data);
					return 500;
				}
			}
			if (qh_sbuf_append(&sb, "]}", 2) < 0) { free(sb.data); return 500; }
		}
		if (qh_sbuf_append(&sb, "]", 1) < 0) { free(sb.data); return 500; }
	} else if (!strcmp(buf, "downtimes")) {
		scheduled_downtime *dt;
		if (qh_sbuf_append(&sb, "[", 1) < 0) { free(sb.data); return 500; }
		for (dt = scheduled_downtime_list; dt != NULL; dt = dt->next) {
			if (!first && qh_sbuf_append(&sb, ",", 1) < 0) { free(sb.data); return 500; }
			first = 0;
			if (qh_sbuf_printf(&sb,
					"{\"downtime_id\":%lu,\"type\":%d,\"host_name\":",
					dt->downtime_id, dt->type) < 0 ||
				qh_sbuf_json_str(&sb, dt->host_name) < 0 ||
				qh_sbuf_append(&sb, ",\"service_description\":", 23) < 0 ||
				qh_sbuf_json_str(&sb, dt->service_description) < 0 ||
				qh_sbuf_printf(&sb,
					",\"entry_time\":%llu,\"start_time\":%llu,\"end_time\":%llu,"
					"\"fixed\":%d,\"duration\":%lu,\"is_in_effect\":%d,\"author\":",
					(unsigned long long)dt->entry_time,
					(unsigned long long)dt->start_time,
					(unsigned long long)dt->end_time,
					dt->fixed, dt->duration, dt->is_in_effect) < 0 ||
				qh_sbuf_json_str(&sb, dt->author) < 0 ||
				qh_sbuf_append(&sb, ",\"comment\":", 11) < 0 ||
				qh_sbuf_json_str(&sb, dt->comment) < 0 ||
				qh_sbuf_append(&sb, "}", 1) < 0) {
				free(sb.data);
				return 500;
			}
		}
		if (qh_sbuf_append(&sb, "]", 1) < 0) { free(sb.data); return 500; }
	} else if (!strcmp(buf, "comments")) {
		nagios_comment *cm;
		if (qh_sbuf_append(&sb, "[", 1) < 0) { free(sb.data); return 500; }
		for (cm = comment_list; cm != NULL; cm = cm->next) {
			if (!first && qh_sbuf_append(&sb, ",", 1) < 0) { free(sb.data); return 500; }
			first = 0;
			if (qh_sbuf_printf(&sb,
					"{\"comment_id\":%lu,\"comment_type\":%d,\"entry_type\":%d,\"host_name\":",
					cm->comment_id, cm->comment_type, cm->entry_type) < 0 ||
				qh_sbuf_json_str(&sb, cm->host_name) < 0 ||
				qh_sbuf_append(&sb, ",\"service_description\":", 23) < 0 ||
				qh_sbuf_json_str(&sb, cm->service_description) < 0 ||
				qh_sbuf_printf(&sb,
					",\"entry_time\":%llu,\"persistent\":%d,\"author\":",
					(unsigned long long)cm->entry_time, cm->persistent) < 0 ||
				qh_sbuf_json_str(&sb, cm->author) < 0 ||
				qh_sbuf_append(&sb, ",\"comment_data\":", 16) < 0 ||
				qh_sbuf_json_str(&sb, cm->comment_data) < 0 ||
				qh_sbuf_append(&sb, "}", 1) < 0) {
				free(sb.data);
				return 500;
			}
		}
		if (qh_sbuf_append(&sb, "]", 1) < 0) { free(sb.data); return 500; }
	} else {
		return 404;
	}

	/* Include terminating NUL byte as query handler response delimiter */
	if (qh_write_all(sd, sb.data, sb.len + 1) < 0) {
		free(sb.data);
		return -1;
	}
	free(sb.data);
	return 0;
}

int qh_init(const char *path)
{
	int result    = 0;
	int old_umask = 0;

	if (qh_listen_sock >= 0) {
		iobroker_close(nagios_iobs, qh_listen_sock);
	}

	if (path == NULL) {

		logit(NSLOG_RUNTIME_ERROR, TRUE, "qh: query_socket is NULL. What voodoo is this?\n");
		return ERROR;
	}

	old_umask = umask(0117);
	errno = 0;
	qh_listen_sock = nsock_unix(path, NSOCK_TCP | NSOCK_UNLINK);
	umask(old_umask);

	if (qh_listen_sock < 0) {

		logit(NSLOG_RUNTIME_ERROR, TRUE, "qh: Failed to init socket '%s'. %s: %s\n",
			  path, nsock_strerror(qh_listen_sock), strerror(errno));
		return ERROR;
	}

	/* plugins shouldn't have this socket */
	result = fcntl(qh_listen_sock, F_SETFD, FD_CLOEXEC);
	if (result == -1) {

		logit(NSLOG_RUNTIME_ERROR, TRUE, "qh: Failed to fcntl() query handler socket\n");
	}

	/* most likely overkill, but it's small, so... */
	qh_table = dkhash_create(1024);
	if (qh_table == NULL) {

		logit(NSLOG_RUNTIME_ERROR, TRUE, "qh: Failed to create hash table\n");
		close(qh_listen_sock);
		return ERROR;
	}

	errno = 0;
	result = iobroker_register(nagios_iobs, qh_listen_sock, NULL, qh_input);
	if (result < 0) {

		dkhash_destroy(qh_table);
		close(qh_listen_sock);
		logit(NSLOG_RUNTIME_ERROR, TRUE, "qh: Failed to register socket with io broker: %s; errno=%d: %s\n", iobroker_strerror(result), errno, strerror(errno));
		return ERROR;
	}

	logit(NSLOG_INFO_MESSAGE, FALSE, "qh: Socket '%s' successfully initialized\n", path);

	/* now register our the in-core handlers */
	result = qh_register_handler("core", "Nagios Core control and info", 0, qh_core);
	if (result == OK) {
		logit(NSLOG_INFO_MESSAGE, FALSE, "qh: core query handler registered\n");
	}

	result = qh_register_handler("echo", "The Echo Service - What You Put Is What You Get", 0, qh_echo);
	if (result == OK) {
		logit(NSLOG_INFO_MESSAGE, FALSE, "qh: echo service query handler registered\n");
	}

	result = qh_register_handler("help", "Help for the query handler", 0, qh_help);
	if (result == OK) {
		logit(NSLOG_INFO_MESSAGE, FALSE, "qh: help for the query handler registered\n");
	}

	result = qh_register_handler("state", "In-memory host and service state JSON snapshots", 0, qh_state);
	if (result == OK) {
		logit(NSLOG_INFO_MESSAGE, FALSE, "qh: state query handler registered\n");
	}

	return 0;
}
