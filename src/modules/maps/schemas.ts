import { z } from 'zod';

/** Google accepts URL-safe base64 up to 36 chars; apps send a UUID v4 per search session. */
const sessionToken = z.string().regex(/^[A-Za-z0-9_-]{8,36}$/, 'Invalid sessionToken');

const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);

export const autocompleteQuerySchema = z
  .object({
    q: z.string().max(120).default(''),
    sessionToken,
    lat: lat.optional(),
    lng: lng.optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: 'lat and lng must be sent together',
    path: ['lat'],
  });

export const placeQuerySchema = z.object({
  // Charset check matters: placeId is put into the Google URL path.
  placeId: z.string().regex(/^[A-Za-z0-9_-]{10,512}$/, 'Invalid placeId'),
  sessionToken: sessionToken.optional(),
});

export const reverseQuerySchema = z.object({ lat, lng });
